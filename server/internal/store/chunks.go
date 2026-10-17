package store

// Stored Wilds chunks (server-first.md 3.3, open-map.md 2.3): a world's
// epochs by kind, and its chunks, each made the first time it is read and
// only ever read after that. Chunks implements chunks.ChunkSource and
// chunks.EpochComposition.

import (
	"container/list"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/frontier"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/wilds"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// ChunkCacheSize is how many decoded chunks stay in memory.
const ChunkCacheSize = 512

// ErrGeneratorUnavailable: this build has no generator for new epochs, or
// an epoch names a generator version it can't make.
var ErrGeneratorUnavailable = errors.New("generator unavailable")

type Chunks struct {
	// Now is the clock for epoch lifetimes on chunk reads (the port's read
	// takes no time). Nil is time.Now.
	Now func() time.Time
	// Generator makes chunks on demand and names the version new epochs
	// use. Nil: none can be made (generator-unavailable).
	Generator chunks.Generator
	// Holders judge the holds of each holder kind at the turning
	// (holds.go). A kind with none keeps its holds.
	Holders map[string]Holder

	mu    sync.Mutex
	order *list.List // front: most recent
	byKey map[chunkKey]*list.Element
}

type chunkKey struct {
	epoch     string
	layer, cx int32
	cy        int32
}

type cached struct {
	key   chunkKey
	chunk *contract.WorldChunk
}

func NewChunks(now func() time.Time, g chunks.Generator) *Chunks {
	return &Chunks{Now: now, Generator: g, order: list.New(), byKey: map[chunkKey]*list.Element{}}
}

const epochSelect = "SELECT id,world_seed,kind,generator_version,season,starts_at,ends_at FROM wild_epochs "

func scanEpochRow(row *sql.Row) (*contract.WildsEpoch, error) {
	var e contract.WildsEpoch
	var starts int64
	var ends sql.NullInt64
	if err := row.Scan(&e.Id, &e.WorldSeed, &e.Kind, &e.GeneratorVersion, &e.Season, &starts, &ends); err != nil {
		return nil, err
	}
	e.StartsAt = float64(starts)
	if ends.Valid {
		e.EndsAt = wrapperspb.Double(float64(ends.Int64))
	}
	return &e, nil
}

// Epoch kinds (open-map.md 2.3).
const (
	EpochStill = "still"
	EpochWick  = "wick"
)

// Current is the world's newest epoch of the kind and the current generator
// version. It never creates: none is sql.ErrNoRows, an ended one
// chunks.ErrEpochEnded.
func (c *Chunks) Current(ctx context.Context, tx *sql.Tx, world, kind string, now int64) (*contract.WildsEpoch, error) {
	e, err := scanEpochRow(tx.QueryRowContext(ctx, epochSelect+"WHERE world_id=? AND kind=? AND generator_version=? ORDER BY starts_at DESC LIMIT 1", world, kind, c.version()))
	if err != nil {
		return nil, err
	}
	if e.EndsAt != nil && e.EndsAt.Value <= float64(now) {
		return nil, chunks.ErrEpochEnded
	}
	return e, nil
}

// EpochByID reads one of the world's epochs by id, ended or not, of any
// version (sql.ErrNoRows for another world's).
func (c *Chunks) EpochByID(ctx context.Context, tx *sql.Tx, world, id string) (*contract.WildsEpoch, error) {
	return scanEpochRow(tx.QueryRowContext(ctx, epochSelect+"WHERE id=? AND world_id=?", id, world))
}

// Create makes the kind's epoch for now, in the caller's transaction. The
// still epoch's season is "0" (it never ends) and it is made with every
// still footprint's chunks (the Tangle's nine), so a wick chunk at the seam
// always finds its kept side. A wick epoch's season is the wick's bounds,
// "t:<startsAt>:<endsAt>", and its chunks are made on demand. Making one
// deletes the world's ended wick epochs and an epoch of another generator
// version left for the same season, with everything stored under them, but
// for epochs a hold pins. Making a wick epoch is the turning: the holds are
// judged then, once (holds.go), before any chunk of it is made.
// A Create that races another for the same season answers the one stored.
func (c *Chunks) Create(ctx context.Context, tx *sql.Tx, world, kind string, now int64) (*contract.WildsEpoch, error) {
	if kind != EpochStill && kind != EpochWick {
		return nil, sql.ErrNoRows
	}
	version := c.version()
	if version == 0 {
		return nil, ErrGeneratorUnavailable
	}
	season, starts := "0", now
	var ends *int64
	if kind == EpochWick {
		day := content.CalendarAt(content.CalendarRules, now)
		season = "t:" + strconv.FormatInt(day.StartsAt, 10) + ":" + strconv.FormatInt(day.NextTurning, 10)
		starts = day.StartsAt
		end := day.NextTurning
		ends = &end
	}
	if err := deleteStaleEpochs(ctx, tx, world, kind, season, version, content.CalendarAt(content.CalendarRules, now).StartsAt); err != nil {
		return nil, err
	}
	var seed string
	if err := tx.QueryRowContext(ctx, "SELECT seed FROM worlds WHERE id=?", world).Scan(&seed); err != nil {
		return nil, err
	}
	id, err := Random()
	if err != nil {
		return nil, err
	}
	res, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO wild_epochs(id,world_id,kind,world_seed,generator_version,season,starts_at,ends_at) VALUES(?,?,?,?,?,?,?,?)", id, world, kind, seed, version, season, starts, ends)
	if err != nil {
		return nil, err
	}
	e, err := scanEpochRow(tx.QueryRowContext(ctx, epochSelect+"WHERE world_id=? AND kind=? AND season=?", world, kind, season))
	if err != nil {
		return nil, err
	}
	// This season's epoch was there already: a racing Create stored it, or
	// it has ended (its end was moved by hand, or the calendar was retuned
	// onto the same bounds) and is never reopened.
	if n, _ := res.RowsAffected(); n == 0 {
		if e.EndsAt != nil && e.EndsAt.Value <= float64(now) {
			return nil, chunks.ErrEpochEnded
		}
		return e, nil
	}
	if kind == EpochWick {
		gone, err := c.judgeHolds(ctx, tx, world, now)
		if err != nil {
			return nil, err
		}
		wickStart := content.CalendarAt(content.CalendarRules, now).StartsAt
		if gone {
			if err = deleteStaleEpochs(ctx, tx, world, kind, season, version, wickStart); err != nil {
				return nil, err
			}
		}
		if err = trimPinned(ctx, tx, world, wickStart); err != nil {
			return nil, err
		}
	}
	if kind == EpochStill {
		for _, p := range content.WildsRules.Places {
			if p.GetEpochKind() != EpochStill {
				continue
			}
			for cy := p.GetCy(); cy < p.GetCy()+p.GetHeight(); cy++ {
				for cx := p.GetCx(); cx < p.GetCx()+p.GetWidth(); cx++ {
					if _, err = c.Chunk(ctx, tx, world, e.Id, 0, cx, cy); err != nil {
						return nil, fmt.Errorf("still chunk %d,%d: %w", cx, cy, err)
					}
				}
			}
		}
	}
	return e, nil
}

// deleteStaleEpochs: the world's wick epochs that ended before this wick
// began, and an epoch of the kind and season made by another generator
// version, go with their chunks, entity state, claims, discoveries,
// lanterns (all cascading) and world changes in the Wilds' realm (another
// realm's rows are that realm's to keep). The wick that ended at this
// one's start stays until the next turning, so a late claim on it still
// hears "epoch-ended" rather than "epoch-not-found". An epoch a hold pins
// stays, with its stored chunks and ground changes (trimPinned trims it).
func deleteStaleEpochs(ctx context.Context, tx *sql.Tx, world, kind, season string, version int, wickStart int64) error {
	const stale = "(SELECT id FROM wild_epochs WHERE world_id=? AND (kind=? AND season=? AND generator_version!=? OR kind='wick' AND ends_at<?) AND id NOT IN (SELECT epoch_id FROM holds))"
	if _, err := tx.ExecContext(ctx, "DELETE FROM world_changes WHERE world_id=? AND realm=? AND epoch IN "+stale, world, content.WildsRules.GetRealm(), world, kind, season, version, wickStart); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "DELETE FROM wild_epochs WHERE id IN "+stale, world, kind, season, version, wickStart)
	return err
}

// Chunk reads one chunk of an epoch in the caller's world, making it the
// first time it is asked for (open-map.md 2.3): only inside the frontier, on
// layer 0, in the epoch its coordinates call for, and by the epoch's own
// generator version. The blob is stored under a unique key, so of two racing
// first reads one blob wins and both answer it. Another world's epoch, an
// epoch of another generator version and a chunk that can't be made are all
// sql.ErrNoRows; an ended epoch is chunks.ErrEpochEnded. A held chunk
// (holds.go) is read under its pinned epoch, ended or of an older version,
// from its stored blob only.
//
// The memory cache is shared by every transaction, but a chunk made in one
// may be rolled back with it (a refused operation, a savepoint). So a cache
// hit counts only when the chunk's row exists in the caller's transaction,
// read in the same query as the epoch.
//
// A chunk of a fixed footprint (location.SourceOf) is the fixed source's,
// in every world, before any epoch is read: only under its layout's
// current pseudo-epoch ("fixed:<layout>@<revision>"), never stored, kept in
// the LRU under that pseudo-epoch (a new revision is a new key). Any other
// epoch there, or a fixed pseudo-epoch anywhere else, is sql.ErrNoRows.
func (c *Chunks) Chunk(ctx context.Context, tx *sql.Tx, world, epoch string, layer, cx, cy int32) (*contract.WorldChunk, error) {
	if src := location.SourceOf(int(cx), int(cy)); src.Kind == location.SourceFixed || chunks.IsFixedEpoch(epoch) || strings.HasPrefix(epoch, "plot:") {
		expected := chunks.FixedEpoch(src.Layout, src.Revision)
		plot := src.Kind == location.SourceFixed && chunks.IsLotLayout(src.Layout)
		if plot {
			expected = chunks.PlotEpoch(world, chunks.LotAt(int(cx), int(cy)))
		}
		if src.Kind != location.SourceFixed || layer != 0 || epoch != expected {
			return nil, sql.ErrNoRows
		}
		key := chunkKey{epoch, layer, cx, cy}
		m := c.get(key)
		if m == nil {
			if plot {
				m = chunks.Plot(world, chunks.LotAt(int(cx), int(cy)))
			} else {
				m = chunks.Fixed(epoch, cx, cy)
			}
			if m == nil {
				return nil, sql.ErrNoRows
			}
			c.put(key, m)
		}
		return proto.Clone(m).(*contract.WorldChunk), nil
	}
	var e contract.WildsEpoch
	var starts int64
	var ends sql.NullInt64
	var stored, held bool
	err := tx.QueryRowContext(ctx, `SELECT id,world_seed,kind,generator_version,season,starts_at,ends_at,
 EXISTS(SELECT 1 FROM wilds_chunks WHERE epoch_id=wild_epochs.id AND layer=? AND cx=? AND cy=?),
 EXISTS(SELECT 1 FROM holds WHERE world_id=wild_epochs.world_id AND realm=? AND layer=? AND cx=? AND cy=? AND epoch_id=wild_epochs.id)
 FROM wild_epochs WHERE id=? AND world_id=?`, layer, cx, cy, content.WildsRules.GetRealm(), layer, cx, cy, epoch, world).Scan(&e.Id, &e.WorldSeed, &e.Kind, &e.GeneratorVersion, &e.Season, &starts, &ends, &stored, &held)
	if err != nil {
		return nil, err
	}
	e.StartsAt = float64(starts)
	if ends.Valid {
		e.EndsAt = wrapperspb.Double(float64(ends.Int64))
	}
	key := chunkKey{epoch, layer, cx, cy}
	// A held chunk is its pinned epoch's stored blob, whatever the epoch's
	// end or generator version: never made again.
	if held && stored {
		return c.readStored(ctx, tx, key)
	}
	if int(e.GeneratorVersion) != c.version() {
		return nil, sql.ErrNoRows
	}
	if e.EndsAt != nil && e.EndsAt.Value <= float64(c.readNow(ctx)) {
		return nil, chunks.ErrEpochEnded
	}
	if !stored {
		c.drop(key)
		m, err := c.make(ctx, tx, world, &e, layer, cx, cy)
		if err != nil {
			return nil, err
		}
		c.put(key, m)
		return proto.Clone(m).(*contract.WorldChunk), nil
	}
	return c.readStored(ctx, tx, key)
}

// readStored answers a stored chunk, through the memory cache.
func (c *Chunks) readStored(ctx context.Context, tx *sql.Tx, key chunkKey) (*contract.WorldChunk, error) {
	if m := c.get(key); m != nil {
		return proto.Clone(m).(*contract.WorldChunk), nil
	}
	m, err := c.stored(ctx, tx, key)
	if err != nil {
		return nil, err
	}
	c.put(key, m)
	return proto.Clone(m).(*contract.WorldChunk), nil
}

func (c *Chunks) stored(ctx context.Context, tx *sql.Tx, k chunkKey) (*contract.WorldChunk, error) {
	var blob []byte
	if err := tx.QueryRowContext(ctx, "SELECT blob FROM wilds_chunks WHERE epoch_id=? AND layer=? AND cx=? AND cy=?", k.epoch, k.layer, k.cx, k.cy).Scan(&blob); err != nil {
		return nil, err
	}
	m := &contract.WorldChunk{}
	if err := proto.Unmarshal(blob, m); err != nil {
		return nil, err
	}
	return m, nil
}

// make generates a chunk and stores it, then answers what is stored.
func (c *Chunks) make(ctx context.Context, tx *sql.Tx, world string, e *contract.WildsEpoch, layer, cx, cy int32) (*contract.WorldChunk, error) {
	x, y := int(cx), int(cy)
	if layer != 0 || !frontier.Inside(world, x, y) || wilds.EpochKindAt(x, y) != e.Kind {
		return nil, sql.ErrNoRows
	}
	if c.Generator == nil {
		return nil, ErrGeneratorUnavailable
	}
	var kept []chunks.Kept
	if e.Kind == EpochWick {
		// Held chunks round it, pinned to other wick epochs, are kept as
		// the Tangle is; a chunk held under another epoch is never made in
		// this one.
		heldAt := map[[2]int]string{}
		rows, err := tx.QueryContext(ctx, "SELECT cx,cy,epoch_id FROM holds WHERE world_id=? AND realm=? AND layer=0 AND cx BETWEEN ? AND ? AND cy BETWEEN ? AND ? AND epoch_id!=?", world, content.WildsRules.GetRealm(), cx-1, cx+1, cy-1, cy+1, e.Id)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var hx, hy int
			var id string
			if err = rows.Scan(&hx, &hy, &id); err != nil {
				rows.Close()
				return nil, err
			}
			heldAt[[2]int{hx, hy}] = id
		}
		rows.Close()
		if err = rows.Err(); err != nil {
			return nil, err
		}
		if _, ok := heldAt[[2]int{x, y}]; ok {
			return nil, sql.ErrNoRows
		}
		for d, id := range heldAt {
			m, err := c.Chunk(ctx, tx, world, id, 0, int32(d[0]), int32(d[1]))
			if err != nil {
				return nil, fmt.Errorf("held side of %d,%d: %w", x, y, err)
			}
			kept = append(kept, chunks.Kept{CX: d[0], CY: d[1], Chunk: m, Held: true})
		}
		var still *contract.WildsEpoch
		for dy := int32(-1); dy <= 1; dy++ {
			for dx := int32(-1); dx <= 1; dx++ {
				nx, ny := x+int(dx), y+int(dy)
				if dx == 0 && dy == 0 {
					continue
				}
				src := location.SourceOf(nx, ny)
				if src.Kind == location.SourceFixed {
					epoch := chunks.FixedEpoch(src.Layout, src.Revision)
					if chunks.IsLotLayout(src.Layout) {
						epoch = chunks.PlotEpoch(world, chunks.LotAt(nx, ny))
					}
					m, err := c.Chunk(ctx, tx, world, epoch, 0, int32(nx), int32(ny))
					if err != nil {
						return nil, fmt.Errorf("fixed kept side of %d,%d: %w", x, y, err)
					}
					kept = append(kept, chunks.Kept{CX: nx, CY: ny, Chunk: m})
					continue
				}
				if wilds.EpochKindAt(nx, ny) != EpochStill || !frontier.Inside(world, nx, ny) {
					continue
				}
				if still == nil {
					var err error
					if still, err = chunks.Epoch(ctx, tx, c, world, EpochStill, c.readNow(ctx)); err != nil {
						return nil, fmt.Errorf("kept side of %d,%d: %w", x, y, err)
					}
				}
				m, err := c.Chunk(ctx, tx, world, still.Id, 0, int32(nx), int32(ny))
				if err != nil {
					return nil, fmt.Errorf("kept side of %d,%d: %w", x, y, err)
				}
				kept = append(kept, chunks.Kept{CX: nx, CY: ny, Chunk: m})
			}
		}
	}
	m, err := c.Generator.Chunk(proto.Clone(e).(*contract.WildsEpoch), cx, cy, kept)
	if err != nil {
		return nil, err
	}
	if err = chunks.Validate(m); err != nil {
		return nil, fmt.Errorf("generated chunk %d,%d: %w", x, y, err)
	}
	if m.EpochId != e.Id || m.Cx != cx || m.Cy != cy || m.Layer != layer || int(m.GeneratorVersion) != int(e.GeneratorVersion) {
		return nil, fmt.Errorf("generated chunk %d,%d: wrong identity", x, y)
	}
	blob, err := proto.Marshal(m)
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO wilds_chunks(epoch_id,layer,cx,cy,generator_version,blob,created_at) VALUES(?,?,?,?,?,?,?)", e.Id, layer, cx, cy, e.GeneratorVersion, blob, c.readNow(ctx)); err != nil {
		return nil, err
	}
	return c.stored(ctx, tx, chunkKey{e.Id, layer, cx, cy})
}

// version is the generator version new epochs use (zero: none).
func (c *Chunks) version() int {
	if c.Generator == nil {
		return 0
	}
	return c.Generator.Version()
}

func (c *Chunks) now() int64 {
	if c.Now == nil {
		return time.Now().Unix()
	}
	return c.Now().Unix()
}

func (c *Chunks) get(k chunkKey) *contract.WorldChunk {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.byKey == nil {
		return nil
	}
	el, ok := c.byKey[k]
	if !ok {
		return nil
	}
	c.order.MoveToFront(el)
	return el.Value.(cached).chunk
}

// drop forgets a cached chunk whose row isn't there (its making rolled back).
func (c *Chunks) drop(k chunkKey) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.byKey[k]; ok {
		c.order.Remove(el)
		delete(c.byKey, k)
	}
}

func (c *Chunks) put(k chunkKey, m *contract.WorldChunk) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.byKey == nil {
		c.order, c.byKey = list.New(), map[chunkKey]*list.Element{}
	}
	if el, ok := c.byKey[k]; ok {
		c.order.MoveToFront(el)
		return
	}
	c.byKey[k] = c.order.PushFront(cached{k, m})
	for c.order.Len() > ChunkCacheSize {
		last := c.order.Back()
		delete(c.byKey, last.Value.(cached).key)
		c.order.Remove(last)
	}
}

func (c *Chunks) readNow(ctx context.Context) int64 {
	if now, ok := chunks.ReadTime(ctx); ok {
		return now.Unix()
	}
	return c.now()
}
