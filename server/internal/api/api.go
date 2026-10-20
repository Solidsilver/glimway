// Package api implements the HTTP and presence contracts. All gameplay commits,
// authorization checks, ledger entries and idempotency responses share one tx.
package api

import (
	"context"
	"errors"
	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/habitica"
	"glimway/server/internal/ports"
	"glimway/server/internal/store"
	"glimway/server/internal/story"
	"glimway/server/internal/wildsgen"
	"io"
	"log"
	"net/http"
	"sync"
	"time"
)

const CookieName = "glimway_session"

const SessionTTL = 30 * 24 * time.Hour

const SessionIdleTTL = 7 * 24 * time.Hour

type Config struct {
	// FightMetrics keeps the fight rooms' tick and byte samples (nil: New
	// makes one).
	FightMetrics     *FightMetrics
	Lanterns         ports.Lanterns
	Story            ports.StoryRules
	Placement        ports.Placement
	HomeLand         ports.HomeLandSource
	State            store.StateComposition
	Chunks           chunks.ChunkSource
	Epochs           chunks.EpochComposition
	SecureCookie     bool
	Logger           *log.Logger
	Now              func() time.Time
	TrustedProxies   []string
	LoginConcurrency int
	LoginRate        int
	LoginGlobalRate  int
	LoginWindow      time.Duration
	// WildsGenerator makes the open map's chunks on demand, and answers the
	// glimpse past the border and the wick's rumour. Nil is generator v3
	// (wildsgen.V3); tests pass a stand-in. Stored epochs keep the version
	// they were made by.
	WildsGenerator chunks.Generator
	// Nil uses the shared presence defaults. Intended for embedded-server configuration.
	Presence *content.Presence
	// PresenceFlushMs batches peer output on the shared presence sweep (0: immediate).
	PresenceFlushMs int
	// PartyAdmissionOff: no one signs in through a party, and no party's
	// world is made (-party-admission=false). Party worlds already made stay.
	PartyAdmissionOff bool
	// LoginPartyRate: upstream calls a minute for sign-ins that only a party
	// could admit, a bucket apart from LoginGlobalRate (zero: a quarter of it).
	LoginPartyRate int
	// Habitica outfit art (sprites.go): where fetched sprites are kept on
	// disk (empty: a folder in the system temp dir) and the sprite host
	// (empty: DefaultSpriteBaseURL; the playtests point it at a fake).
	SpriteCacheDir string
	SpriteBaseURL  string
	// The server build (-ldflags -X in main), reported by GET /api/health.
	// Empty reads as "dev"; Build is left out when unknown.
	Version string
	Build   string
	// PurseChecks are the balance checks after a score whose outcome is
	// unknown (design 2.3: about 2, 5, 10, 20 and 35 seconds after the
	// failed call). Tunable for tests; the empty slice uses the design's.
	PurseChecks []time.Duration
	// PurseAnswerWait is how long a top-up's POST waits for its worker
	// before answering "working" (design 2.2: 8 seconds).
	PurseAnswerWait time.Duration
	// WebSettings is GET /api/web-settings' answer for a request (the
	// server command's settings, per account). Nil: no settings, no dev tools.
	WebSettings func(*http.Request) any
}

type Server struct {
	Store *store.Store
	// Habitica is the narrow upstream slice the server calls (habitica.Upstream):
	// the sign-in proof and the purse's calls. Tests inject a stub.
	Habitica    habitica.Upstream
	Config      Config
	loginSlots  chan struct{}
	loginLimit  *loginLimiter
	loginGlobal *loginLimiter
	loginParty  *loginLimiter
	loginProofs *proofLimiter
	presence    *presenceHub
	sprites     *spriteProxy
	// workers counts the detached top-up workers, so Close can wait for
	// them (finding 11): a worker about to settle a `moved` row must not
	// have its database closed under it.
	workers sync.WaitGroup
	// Live reservations include the interval before the worker starts and all
	// detached checks/settlement. A restart leaves no live entries.
	liveTopUps sync.Map
	// topUpMark lets a test fail the worker's state marks (finding 1: a
	// failed `checking` mark must never stop the checks). Nil in production.
	topUpMark func(id, state string) error
	// falls is the one durable fall writer (fall_writer.go): camp falls
	// leave the fight rooms through it, never from a tick.
	falls *fallWriter
	// visits are the presence socket's chunk visits written this wick
	// (common_ways.go).
	visits visitCache
}

func New(s *store.Store, h habitica.Upstream, c Config) *Server {
	if c.FightMetrics == nil {
		c.FightMetrics = NewFightMetrics()
	}
	if c.State == nil {
		c.State = store.DefaultStateComposition{}
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	// Every answer carries the account's fishing (design 5.5) and its purse
	// (design 2): the same state composition, one decorator each.
	c.State = fishingComposition{StateComposition: c.State}
	c.State = purseComposition{StateComposition: c.State}
	// …and the wardrobe's resolved choice (design 4.4).
	c.State = wardrobeComposition{StateComposition: c.State}
	if c.WildsGenerator == nil {
		c.WildsGenerator = wildsgen.V3{}
	}
	if c.Chunks == nil || c.Epochs == nil {
		stored := store.NewChunks(c.Now, c.WildsGenerator)
		if c.Chunks == nil {
			c.Chunks = stored
		}
		if c.Epochs == nil {
			c.Epochs = stored
		}
	}
	// The holder kinds judged at the turning (store/holds.go): the server's
	// own chunks always judge lot lanterns and way-lamps, so a lapse
	// reaches Released.
	if held, ok := c.Epochs.(*store.Chunks); ok {
		if held.Holders == nil {
			held.Holders = map[string]store.Holder{}
		}
		if held.Holders[lotLanternKind] == nil {
			held.Holders[lotLanternKind] = lotLanternHolder{}
		}
		if held.Holders[wayLampKind] == nil {
			held.Holders[wayLampKind] = wayLampHolder{}
		}
	}
	if c.Logger == nil {
		c.Logger = log.New(io.Discard, "", 0)
	}

	sr := story.Rules{Chunks: c.Chunks, Epochs: c.Epochs, Now: c.Now}
	if c.Story == nil {
		c.Story = sr
	}
	if c.Placement == nil {
		c.Placement = sr
	}
	a := newServer(s, h, c)
	// …and Common ways after them (common_ways.go).
	if held, ok := c.Epochs.(*store.Chunks); ok && held.Commons == nil {
		held.Commons = commonWays{a}
	}
	// …and this wick's rumour (open-map.md 2.10), read through the server's
	// own epochs and generator.
	a.Config.State = rumourComposition{StateComposition: a.Config.State, a: a}
	return a
}

func newServer(s *store.Store, h habitica.Upstream, c Config) *Server {
	if c.LoginConcurrency <= 0 {
		c.LoginConcurrency = 4
	}
	if c.LoginRate <= 0 {
		c.LoginRate = 10
	}
	if c.LoginGlobalRate <= 0 {
		c.LoginGlobalRate = 60
	}
	if c.LoginWindow <= 0 {
		c.LoginWindow = time.Minute
	}
	if c.LoginPartyRate <= 0 {
		c.LoginPartyRate = max(1, c.LoginGlobalRate/4)
	}
	hub := newPresenceHub(c.Presence, c.Now)
	if c.PresenceFlushMs != 0 && c.PresenceFlushMs != 50 && c.PresenceFlushMs != 100 {
		panic("PresenceFlushMs must be 0, 50, or 100")
	}
	hub.flushMs = c.PresenceFlushMs
	a := &Server{sprites: newSpriteProxy(c.SpriteCacheDir, c.SpriteBaseURL, c.Now), presence: hub, loginProofs: &proofLimiter{buckets: map[string]*proofBucket{}}, loginGlobal: &loginLimiter{buckets: map[string]loginBucket{}, rate: c.LoginGlobalRate, window: time.Minute}, loginParty: &loginLimiter{buckets: map[string]loginBucket{}, rate: c.LoginPartyRate, window: time.Minute}, Store: s, Habitica: h, Config: c, loginSlots: make(chan struct{}, c.LoginConcurrency), loginLimit: &loginLimiter{buckets: map[string]loginBucket{}, rate: c.LoginRate, window: c.LoginWindow}}
	a.falls = newFallWriter(func(ctx context.Context, f store.FallRecord) (bool, error) {
		if a.Store == nil {
			return false, errors.New("no store")
		}
		return a.Store.InsertFall(ctx, f)
	}, func(format string, v ...any) {
		if a.Config.Logger != nil {
			a.Config.Logger.Printf(format, v...)
		}
	})
	// D's region, lantern and land sources read the other ports at call time.
	if a.Config.Lanterns == nil {
		a.Config.Lanterns = wildsService{a}
	}
	if a.Config.HomeLand == nil {
		a.Config.HomeLand = wildsService{a}
	}
	return a
}
