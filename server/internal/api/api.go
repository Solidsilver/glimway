// Package api implements the HTTP and presence contracts. All gameplay commits,
// authorization checks, ledger entries and idempotency responses share one tx.
package api

import (
	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/habitica"
	"glimway/server/internal/ports"
	"glimway/server/internal/store"
	"glimway/server/internal/story"
	"io"
	"log"
	"time"
)

const CookieName = "glimway_session"

const SessionTTL = 30 * 24 * time.Hour

const SessionIdleTTL = 7 * 24 * time.Hour

type Config struct {
	Lanterns         ports.Lanterns
	Story            ports.StoryRules
	Placement        ports.Placement
	Regions          ports.RegionSource
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
	// Zero uses the shared content default; stored epochs always retain their version.
	WildsGeneratorVersion int
	// Nil uses the shared presence defaults. Intended for embedded-server configuration.
	Presence *content.Presence
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
}

type Server struct {
	Store       *store.Store
	Habitica    *habitica.Client
	Config      Config
	loginSlots  chan struct{}
	loginLimit  *loginLimiter
	loginGlobal *loginLimiter
	loginParty  *loginLimiter
	loginProofs *proofLimiter
	presence    *presenceHub
	sprites     *spriteProxy
}

func New(s *store.Store, h *habitica.Client, c Config) *Server {
	if c.State == nil {
		c.State = store.DefaultStateComposition{}
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	// Every answer carries the account's fishing (design 5.5).
	c.State = fishingComposition{StateComposition: c.State, now: c.Now}
	if c.Chunks == nil || c.Epochs == nil {
		stored := store.NewChunks(c.Now)
		stored.GeneratorVersion = c.WildsGeneratorVersion
		if c.Chunks == nil {
			c.Chunks = stored
		}
		if c.Epochs == nil {
			c.Epochs = stored
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
	return newServer(s, h, c)
}

func newServer(s *store.Store, h *habitica.Client, c Config) *Server {
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
	a := &Server{sprites: newSpriteProxy(c.SpriteCacheDir, c.SpriteBaseURL, c.Now), presence: newPresenceHub(c.Presence), loginProofs: &proofLimiter{buckets: map[string]*proofBucket{}}, loginGlobal: &loginLimiter{buckets: map[string]loginBucket{}, rate: c.LoginGlobalRate, window: time.Minute}, loginParty: &loginLimiter{buckets: map[string]loginBucket{}, rate: c.LoginPartyRate, window: time.Minute}, Store: s, Habitica: h, Config: c, loginSlots: make(chan struct{}, c.LoginConcurrency), loginLimit: &loginLimiter{buckets: map[string]loginBucket{}, rate: c.LoginRate, window: c.LoginWindow}}
	// D's region, lantern and land sources read the other ports at call time.
	if a.Config.Regions == nil {
		a.Config.Regions = wildsService{a}
	}
	if a.Config.Lanterns == nil {
		a.Config.Lanterns = wildsService{a}
	}
	if a.Config.HomeLand == nil {
		a.Config.HomeLand = wildsService{a}
	}
	return a
}
