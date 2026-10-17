package api

// Common ways (roadmap 0.13; lamps.md 1.1, 2.3, 2.4): a laid path outside a
// hold is Common. A player standing anywhere in its chunk once in the wick
// keeps it through the turning, carried onto the new wick's land at the
// same tiles; a chunk nobody stood in turns, and each laid tile's stone or
// timber waits for whoever laid it in a crate at Pell's. Presence is one durable flag per
// chunk and wick (store.Visit), written where the server already accepts a
// position: an operation's `where`, a lay's target chunk and the presence
// socket's position in its Wilds room. Nothing is written per step.
//
// The landform lasts between wicks but detail turns, so a carried tile
// clears the new trees and thickets under it (a laid tile is walkable over
// any decor, chunks.Effective). One that would land off land (a ford that
// moved, water) or under a site, an entity or a place's landmark is
// crated instead: a path is never left where it can't be walked, and no
// path tile is invented around it. Named ways are found again over the
// carried tiles; one whose places no longer join goes.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/frontier"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"glimway/server/internal/worldchange"

	"google.golang.org/protobuf/encoding/protojson"
)

// commonWays judges Common work at the turning (store.Commons).
type commonWays struct{ a *Server }

// Turn: a lapsed hold's paths were Built work, never Common: they pack into
// a crate at Pell's for whoever laid them as the land turns (lamps.md 2.3: a
// dimming claim is never kept as Common; 2.7). A way-lamp's camp packs its
// own paths with the rest of the camp (packCamp), so its holds are left to
// it. Then the ended wick's laid paths outside the holds carry or turn by
// their chunk's visits, and its named ways follow them.
func (c commonWays) Turn(ctx context.Context, tx *sql.Tx, world string, ended, next *contract.WildsEpoch, lapsed []store.Hold, now int64) error {
	gone := map[[2]int]bool{}
	for _, h := range lapsed {
		cx, cy := int(h.CX), int(h.CY)
		gone[[2]int{cx, cy}] = true
		if h.HolderKind == wayLampKind {
			continue
		}
		row, err := worldchange.Get(ctx, tx, worldchange.Key{WorldID: world, Realm: content.WildsRules.GetRealm(), Chunk: chunkName(cx, cy), Epoch: h.Epoch, Entity: groundEntity}, groundKind, now)
		if err != nil {
			return err
		}
		if row == nil {
			continue
		}
		g, err := decodeGround(row.State)
		if err != nil {
			return err
		}
		if err = cratePaths(ctx, tx, world, h.HolderKind+":"+h.HolderID, cx, cy, g.Changes, now); err != nil {
			return err
		}
	}
	// Communal lamps go by the same visits and lapses (communal_lamps.go).
	if err := c.turnLamps(ctx, tx, world, ended, next, gone, now); err != nil {
		return err
	}
	if ended == nil {
		return nil
	}
	rows, err := worldchange.Ending(ctx, tx, world, content.WildsRules.GetRealm(), 0, ended.Id, groundKind)
	if err != nil {
		return err
	}
	for _, row := range rows {
		cx, cy, ok := signedPair(row.Chunk, ":")
		if !ok || gone[[2]int{cx, cy}] {
			continue
		}
		// Held land keeps its own changes (store.Chunks.Hold).
		if held, err := store.HeldEpoch(ctx, tx, world, cx, cy); err != nil || held != nil {
			if err != nil {
				return err
			}
			continue
		}
		g, err := decodeGround(row.State)
		if err != nil {
			return err
		}
		laid := slices.DeleteFunc(g.Changes, func(t *contract.GroundChange) bool { return chunks.LayKind(t.Change) == nil })
		if len(laid) == 0 {
			continue
		}
		var land *chunks.Effective
		keep, err := store.VisitedThrough(ctx, tx, world, cx, cy, int64(ended.StartsAt), int64(next.StartsAt))
		if err != nil {
			return err
		}
		if keep && location.SourceOf(cx, cy).Kind == location.SourceGenerated && wilds.EpochKindAt(cx, cy) == store.EpochWick && frontier.Inside(world, cx, cy) {
			m, err := c.a.Config.Chunks.Chunk(ctx, tx, world, next.Id, 0, int32(cx), int32(cy))
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if m != nil {
				e := chunks.NewEffective(m, nil)
				land = &e
			}
		}
		carried := &contract.GroundChanges{Changes: []*contract.GroundChange{}}
		turned := []*contract.GroundChange{}
		for _, t := range laid {
			if land != nil && carries(land, int(t.Tx), int(t.Ty)) {
				carried.Changes = append(carried.Changes, &contract.GroundChange{Tx: t.Tx, Ty: t.Ty, Change: t.Change, By: t.By, At: t.At})
			} else {
				turned = append(turned, t)
			}
		}
		if err = cratePaths(ctx, tx, world, fmt.Sprintf("common:%d:%d", cx, cy), cx, cy, turned, now); err != nil {
			return err
		}
		if len(carried.Changes) == 0 {
			continue
		}
		b, err := protojson.Marshal(carried)
		if err != nil {
			return err
		}
		if err = worldchange.Put(ctx, tx, worldchange.Row{Key: groundKey(world, next, cx, cy), Kind: groundKind, State: b, ChangedBy: row.ChangedBy, EndsAt: epochEnds(next)}, now); err != nil {
			return err
		}
	}
	return c.carryWays(ctx, tx, world, ended, next, now)
}

// carries: a laid tile can lie at (x, y) on the new land: generated land,
// with no site, entity or place's landmark on it.
func carries(e *chunks.Effective, x, y int) bool {
	g := e.BaseGround(x, y)
	return g != nil && g.GetSurface() == "land" && !occupiedAt(e.Chunk, x, y)
}

// cratePaths packs the laid tiles' stone and timber into one crate at
// Pell's (recovery.go; lamps.md 2.4, 2.7), for the source and chunk, once:
// their row goes with the land after this. Each layer gets one stack entry
// a material. Free clearing has nothing to give, and an account that has
// gone has no entry; no tiles to give makes no crate.
func cratePaths(ctx context.Context, tx *sql.Tx, world, source string, cx, cy int, tiles []*contract.GroundChange, now int64) error {
	owed := map[[2]string]int{}
	for _, t := range tiles {
		if lay := chunks.LayKind(t.Change); lay != nil && t.By != "" {
			owed[[2]string{t.By, lay.GetMaterial()}] += int(lay.GetCost())
		}
	}
	keys := make([][2]string, 0, len(owed))
	for k := range owed {
		var known bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM players WHERE account_id=?)", k[0]).Scan(&known); err != nil {
			return err
		}
		if known {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		return nil
	}
	slices.SortFunc(keys, func(a, b [2]string) int { return strings.Compare(a[0]+"\x00"+a[1], b[0]+"\x00"+b[1]) })
	crate, err := store.Random()
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO recovery_crates(id,world_id,source,cx,cy,lapsed_at) VALUES(?,?,?,?,?,?)", crate, world, source, cx, cy, now); err != nil {
		return err
	}
	for _, k := range keys {
		if _, err = tx.ExecContext(ctx, "INSERT INTO recovery_entries(crate_id,account_id,kind,item_def,qty,state) VALUES(?,?,'stack',?,?,'{}')", crate, k[0], k[1], owed[k]); err != nil {
			return err
		}
	}
	return nil
}

// carryWays finds each of the ended wick's named ways again over the new
// wick's laid tiles: kept, name and namer and all, with a fresh path and
// signs while its two places still join; gone otherwise (a dealt place
// moved with the wick, or its path turned).
func (c commonWays) carryWays(ctx context.Context, tx *sql.Tx, world string, ended, next *contract.WildsEpoch, now int64) error {
	rows, err := worldchange.Ending(ctx, tx, world, content.WildsRules.GetRealm(), 0, ended.Id, wayKind)
	if err != nil || len(rows) == 0 {
		return err
	}
	still, err := chunks.Epoch(ctx, tx, c.a.Config.Epochs, world, store.EpochStill, now)
	if err != nil {
		return err
	}
	held, err := store.HeldEpochs(ctx, tx, world)
	if err != nil {
		return err
	}
	w := &pathWorld{a: c.a, ctx: ctx, tx: tx, world: world, now: now, ep: openEpochs{still, next, held}, effs: map[[2]int]*chunks.Effective{}}
	for _, row := range rows {
		way := &contract.WildsWay{}
		if err = protojson.Unmarshal(row.State, way); err != nil {
			return err
		}
		pa, okA := w.place(way.A)
		pb, okB := w.place(way.B)
		var path [][2]int
		var signA, signB [2]int
		ok := false
		if okA && okB {
			path, signA, signB, ok = w.path(pa, pb)
		}
		if w.err != nil {
			return w.err
		}
		if !ok {
			continue
		}
		way.Path, way.SignA, way.SignB = worldTiles(path), worldTiles([][2]int{signA})[0], worldTiles([][2]int{signB})[0]
		way.Tiles = uint32(len(w.run(path[0][0], path[0][1])))
		way.Epoch = next.Id
		if err = c.a.putWay(ctx, tx, world, next, way, row.ChangedBy, now); err != nil {
			return err
		}
	}
	return w.err
}

// ---------------------------------------------------------------- visits

// creditVisit flags the chunk under a Wilds position (world pixels) visited
// this wick, in the caller's transaction: only a wick chunk inside the
// frontier, whose Common work the turning judges.
func creditVisit(ctx context.Context, tx *sql.Tx, world string, x, y float64, now int64) error {
	cx, cy, ok := visitChunk(world, x, y)
	if !ok {
		return nil
	}
	return store.Visit(ctx, tx, world, cx, cy, now)
}

func visitChunk(world string, x, y float64) (int, int, bool) {
	cx, cy := wilds.ChunkOf(wilds.TileOfPixel(x, y))
	return cx, cy, visitable(world, cx, cy)
}

func visitable(world string, cx, cy int) bool {
	return location.SourceOf(cx, cy).Kind == location.SourceGenerated && wilds.EpochKindAt(cx, cy) == store.EpochWick && frontier.Inside(world, cx, cy)
}

type visitKey struct {
	world  string
	cx, cy int
	wick   int64
}

// visitCache remembers the presence socket's visits already written, or
// being written, so a player walking about a chunk writes once a wick. It
// forgets what was written when that grows past visitCacheSize (at worst a
// write again, ignored).
type visitCache struct {
	mu       sync.Mutex
	seen     map[visitKey]bool
	inflight map[visitKey]bool
	writes   sync.WaitGroup
}

const visitCacheSize = 1 << 14

// claim: the visit is neither written nor being written; it is now.
func (v *visitCache) claim(k visitKey) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.seen[k] || v.inflight[k] {
		return false
	}
	if v.inflight == nil {
		v.inflight = map[visitKey]bool{}
	}
	v.inflight[k] = true
	return true
}

func (v *visitCache) settle(k visitKey, written bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	delete(v.inflight, k)
	if !written {
		return
	}
	if v.seen == nil || len(v.seen) >= visitCacheSize {
		v.seen = map[visitKey]bool{}
	}
	v.seen[k] = true
}

// presenceVisit flags a chunk a presence peer stands in, once a wick, in
// its own transaction on its own goroutine: the socket's reader never waits
// on the database (it answers pings). A failed write isn't remembered: the
// next position or heartbeat in the chunk tries again.
func (a *Server) presenceVisit(world string, cx, cy int) {
	if a.Store == nil {
		return
	}
	now := a.presence.now().Unix()
	k := visitKey{world, cx, cy, store.WickStart(now)}
	if !a.visits.claim(k) {
		return
	}
	a.visits.writes.Add(1)
	go func() {
		defer a.visits.writes.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		written := false
		if tx, err := a.Store.DB.BeginTx(ctx, nil); err == nil {
			written = store.Visit(ctx, tx, world, cx, cy, now) == nil && tx.Commit() == nil
			_ = tx.Rollback()
		}
		a.visits.settle(k, written)
	}()
}

// peerVisit is the chunk a peer's accepted position stands in, when that is
// its own Wilds room's chunk (h.mu held): a neighbour's room sees it but is
// never credited, and a position waiting on a join belongs to no room yet.
func peerVisit(p *presencePeer) (int, int, bool) {
	rx, ry, ok := wildsRoomChunk(p.area)
	if !ok || p.pos == nil || p.pendingJoin != "" && p.pendingJoin != p.area {
		return 0, 0, false
	}
	cx, cy, ok := visitChunk(p.identity.World, p.pos.X, p.pos.Y)
	return cx, cy, ok && cx == rx && cy == ry
}
