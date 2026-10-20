package api

// Sight (0.14, docs/planning/wide-world/synthesis.md): with no frontier,
// the chunk and near reads answer only for land round the reader, so nobody
// crawls the world through the API. A read past it is `beyond-sight`.
//
// Sight is measured from the reader's anchor (player_sight), which the
// server keeps. A client's claim of where the hero stands (a report's
// place, an operation's `where`) moves it only as far as the hero could
// have travelled since: the anchor saves up travel at sightSpeed, up to
// sightSaved, and a claim spends what it moves. A claim past that is
// clamped: the anchor moves toward it by what was saved and no further
// (the saved place is still the claim; it is only sight that lags), so an
// honest client that outran its budget for a moment catches up on its next
// reports, and a crafted one travels no faster than a rider. Any other
// change of the saved place is the server's own (a way home, a fall to the
// well, a room's door, a world move, the border's settling, a dev warp):
// the anchor starts again there.
//
// In a room or the cottage, sight is round chunk 0,0, the gate, which the
// map reads round. Reports come about every 10 seconds
// (src/lib/api/reports.ts), and a rider covers about 4.6 chunks in that,
// so the anchor trails the hero by up to sightLag chunks: a near read may
// centre that far from it, and a chunk may be made that far plus the near
// window's radius. Fixed footprints' chunks come from content, held chunks
// are the world's lasting land and the still epoch's (the Tangle) is the
// same for everyone, so all three read from anywhere; any other chunk past
// sight reads only if it is stored already (a land someone walked), never
// made (sightGuard).
//
// A second line: each reader makes at most makeBurst new chunks at once,
// refilled at makeRate a second (an honest rider makes about 3).

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"net/http"
	"sync"
	"time"

	"glimway/server/internal/chunks"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
)

// sightLag: how many chunks the anchor may trail the hero.
const sightLag = 6

// sightChunks: how far from the anchor's chunk a chunk may be made.
const sightChunks = sightLag + NearRadius

// sightSpeed is how fast the anchor may travel, in pixels a second: the
// client's fastest hero rides at 155 (src/game/entities/hero.ts), 178 on
// laid stone, about 210 rolling as often as it may; with room to spare.
const sightSpeed = 260.0

// sightStart is the travel a new anchor has saved (15 seconds' worth), and
// sightSaved the most it saves up (ten minutes').
const (
	sightStart = 15 * sightSpeed
	sightSaved = 600 * sightSpeed
)

// makeBurst and makeRate bound one reader's new chunks: at most makeBurst
// at once, refilled at makeRate a second.
const (
	makeBurst = 300.0
	makeRate  = 5.0
)

// sightAnchor is a reader's anchor (outdoors pixels) and the travel it has
// saved, as of now.
type sightAnchor struct {
	x, y, saved float64
	room        bool // the saved place is a room: sight is round the gate
}

// chunk is the chunk sight is measured from.
func (s sightAnchor) chunk() (int, int) {
	if s.room {
		return 0, 0
	}
	return wilds.ChunkOf(wilds.TileOfPixel(s.x, s.y))
}

// within: chunk (cx, cy) lies within r chunks (Chebyshev) of the anchor.
func (s sightAnchor) within(cx, cy, r int) bool {
	tx, ty := s.chunk()
	return max(abs(cx-tx), abs(cy-ty)) <= r
}

// gatePixel is the middle of chunk 0,0.
func gatePixel() (float64, float64) {
	h := float64(chunkSize() * wildsTileSize / 2)
	return h, h
}

// readSight is the anchor of an account whose saved place is (world, area,
// x, y), at now. A saved place other than the last claim seen is the
// server's: the anchor starts there.
func readSight(ctx context.Context, tx *sql.Tx, account, world, area string, x, y float64, now int64) (sightAnchor, error) {
	var w, seenArea string
	var ax, ay, saved, seenX, seenY float64
	var at int64
	err := tx.QueryRowContext(ctx, "SELECT world_id,x,y,saved,at,seen_area,seen_x,seen_y FROM player_sight WHERE account_id=?", account).Scan(&w, &ax, &ay, &saved, &at, &seenArea, &seenX, &seenY)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return sightAnchor{}, err
	}
	room := area != outdoorsArea
	if err != nil || w != world || seenArea != area || seenX != x || seenY != y {
		if room {
			x, y = gatePixel()
		}
		return sightAnchor{x: x, y: y, saved: sightStart, room: room}, nil
	}
	saved = math.Min(sightSaved, saved+sightSpeed*float64(max(0, now-at)))
	return sightAnchor{x: ax, y: ay, saved: saved, room: room}, nil
}

// sightOf is the reader's anchor, from their snapshot's saved place.
func sightOf(ctx context.Context, tx *sql.Tx, s store.Snapshot, now int64) (sightAnchor, error) {
	return readSight(ctx, tx, s.AccountID, s.WorldID, s.State.Area, s.State.Position.X, s.State.Position.Y, now)
}

// claimSight takes a client's claim that the hero stands at (area, x, y),
// before the snapshot's saved place becomes it: the anchor moves toward it
// as far as it has saved, and the claim is the place seen. The saved place
// is written too, so a chunk made later in this transaction measures from
// this claim (Persist writes it again at the end).
func claimSight(ctx context.Context, tx *sql.Tx, s store.Snapshot, area string, x, y float64, now int64) error {
	a, err := sightOf(ctx, tx, s, now)
	if err != nil {
		return err
	}
	if area == outdoorsArea {
		if a.room {
			a.x, a.y = gatePixel()
		}
		dx, dy := x-a.x, y-a.y
		if d := math.Hypot(dx, dy); d <= a.saved {
			a.x, a.y, a.saved = x, y, a.saved-d
		} else {
			f := a.saved / d
			a.x, a.y, a.saved = a.x+dx*f, a.y+dy*f, 0
		}
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO player_sight(account_id,world_id,x,y,saved,at,seen_area,seen_x,seen_y) VALUES(?,?,?,?,?,?,?,?,?)
 ON CONFLICT(account_id) DO UPDATE SET world_id=excluded.world_id,x=excluded.x,y=excluded.y,saved=excluded.saved,at=excluded.at,seen_area=excluded.seen_area,seen_x=excluded.seen_x,seen_y=excluded.seen_y`,
		s.AccountID, s.WorldID, a.x, a.y, a.saved, now, area, x, y); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE player_place SET area=?,x=?,y=? WHERE account_id=?", area, x, y, s.AccountID)
	return err
}

// errBeyondSight refuses making a chunk past the reader's sight, or past
// their budget of new chunks.
var errBeyondSight = fail(409, "beyond-sight")

// sightGuard is a reader's say over which chunks their reads may make
// (chunks.MakeGuard): ServeHTTP puts one in each request, begin names its
// reader, and the presence socket's fight wake has its own.
type sightGuard struct {
	a       *Server
	account string
	now     func() time.Time // nil: the request's clock
}

func (g *sightGuard) AllowMake(ctx context.Context, tx *sql.Tx, kind string, cx, cy int32) error {
	if g == nil || g.account == "" {
		return nil
	}
	now, _ := chunks.ReadTime(ctx)
	if g.now != nil {
		now = g.now()
	} else if now.IsZero() {
		now = time.Now()
	}
	// The still epoch is a small fixed footprint, the same for everyone.
	if kind != store.EpochStill {
		var world, area string
		var x, y float64
		err := tx.QueryRowContext(ctx, "SELECT p.world_id,pp.area,pp.x,pp.y FROM players p JOIN player_place pp ON pp.account_id=p.account_id WHERE p.account_id=?", g.account).Scan(&world, &area, &x, &y)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		a, err := readSight(ctx, tx, g.account, world, area, x, y, now.Unix())
		if err != nil {
			return err
		}
		if !a.within(int(cx), int(cy), sightChunks) {
			return errBeyondSight
		}
	}
	if !g.a.makes.take(g.account, now) {
		g.a.Config.Logger.Printf("sight: reader over their budget of new chunks")
		return errBeyondSight
	}
	return nil
}

// withSightGuard gives r a guard for its reader, named by begin.
func (a *Server) withSightGuard(r *http.Request) *http.Request {
	return r.WithContext(chunks.WithMakeGuard(r.Context(), &sightGuard{a: a}))
}

// nameReader names the request's reader to its guard.
func nameReader(ctx context.Context, account string) {
	if g, ok := chunks.MakeGuardOf(ctx).(*sightGuard); ok {
		g.account = account
	}
}

// makeBudget is each reader's budget of new chunks, in memory (a restart
// refills it).
type makeBudget struct {
	mu sync.Mutex
	m  map[string]*makeBucket
}

type makeBucket struct {
	left float64
	at   time.Time
}

// take spends one new chunk of account's budget, if there is one.
func (b *makeBudget) take(account string, now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.m == nil {
		b.m = map[string]*makeBucket{}
	}
	k := b.m[account]
	if k == nil {
		if len(b.m) >= 4096 {
			for id, o := range b.m {
				if o.left+makeRate*now.Sub(o.at).Seconds() >= makeBurst {
					delete(b.m, id)
				}
			}
		}
		k = &makeBucket{left: makeBurst, at: now}
		b.m[account] = k
	}
	k.left = math.Min(makeBurst, k.left+makeRate*math.Max(0, now.Sub(k.at).Seconds()))
	k.at = now
	if k.left < 1 {
		return false
	}
	k.left--
	return true
}
