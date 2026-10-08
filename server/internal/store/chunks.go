package store

// Stored Wilds chunks (server-first.md 3.3): a region epoch and all its
// chunks are written in one transaction when the epoch is created, and the
// chunks are only ever read after that. Chunks implements
// chunks.ChunkSource and chunks.EpochComposition.

import (
	"container/list"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/wilds"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// ChunkCacheSize is how many decoded chunks stay in memory.
const ChunkCacheSize = 512

// ErrGeneratorUnavailable: this build can't make epochs of the configured
// generator version.
var ErrGeneratorUnavailable = errors.New("generator unavailable")

type Chunks struct {
	// Now is the clock for epoch lifetimes on chunk reads (the port's read
	// takes no time). Nil is time.Now.
	Now func() time.Time
	// GeneratorVersion for new epochs; zero is content/wilds.json's.
	GeneratorVersion int

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
	chunk *contract.WildsChunk
}

func NewChunks(now func() time.Time) *Chunks {
	return &Chunks{Now: now, order: list.New(), byKey: map[chunkKey]*list.Element{}}
}

const epochSelect = "SELECT id,world_seed,region_id,generator_version,season,starts_at,ends_at FROM region_epochs "

func scanEpochRow(row *sql.Row) (*contract.WildsEpoch, error) {
	var e contract.WildsEpoch
	var starts int64
	var ends sql.NullInt64
	if err := row.Scan(&e.Id, &e.WorldSeed, &e.RegionId, &e.GeneratorVersion, &e.Season, &starts, &ends); err != nil {
		return nil, err
	}
	e.StartsAt = float64(starts)
	if ends.Valid {
		e.EndsAt = wrapperspb.Double(float64(ends.Int64))
	}
	return &e, nil
}

// Current is the region's newest epoch of the current generator version.
// It never creates: none is sql.ErrNoRows, an ended one chunks.ErrEpochEnded.
func (c *Chunks) Current(ctx context.Context, tx *sql.Tx, world, region string, now int64) (*contract.WildsEpoch, error) {
	e, err := scanEpochRow(tx.QueryRowContext(ctx, epochSelect+"WHERE world_id=? AND region_id=? AND generator_version=? ORDER BY starts_at DESC LIMIT 1", world, region, c.version()))
	if err != nil {
		return nil, err
	}
	if e.EndsAt != nil && e.EndsAt.Value <= float64(now) {
		return nil, chunks.ErrEpochEnded
	}
	return e, nil
}

// Create makes the region's epoch for now and stores all its chunks, in the
// caller's transaction. The Tangle's season is "0" (permanent); the
// Whitequiet's is the wick's bounds, "t:<startsAt>:<endsAt>". An epoch of
// another generator version left over for the same season is deleted with
// its rows first (027 deleted them once; development branches can make more).
func (c *Chunks) Create(ctx context.Context, tx *sql.Tx, world, region string, now int64) (*contract.WildsEpoch, error) {
	def, ok := regionDef(region)
	if !ok {
		return nil, sql.ErrNoRows
	}
	version := c.version()
	if version != wilds.GeneratorV2 {
		return nil, ErrGeneratorUnavailable
	}
	season, starts := "0", now
	var ends *int64
	if def.Kind == "outer" {
		day := content.CalendarAt(content.CalendarRules, now)
		season = "t:" + strconv.FormatInt(day.StartsAt, 10) + ":" + strconv.FormatInt(day.NextTurning, 10)
		starts = day.StartsAt
		end := day.NextTurning
		ends = &end
	}
	if err := deleteStaleEpochs(ctx, tx, world, region, season, version); err != nil {
		return nil, err
	}
	// This season's epoch exists but has ended (its end was moved by hand, or
	// the calendar was retuned onto the same bounds): it is never reopened.
	var existing int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM region_epochs WHERE world_id=? AND region_id=? AND season=?", world, region, season).Scan(&existing); err != nil {
		return nil, err
	}
	if existing > 0 {
		return nil, chunks.ErrEpochEnded
	}
	var seed string
	if err := tx.QueryRowContext(ctx, "SELECT seed FROM worlds WHERE id=?", world).Scan(&seed); err != nil {
		return nil, err
	}
	id, err := Random()
	if err != nil {
		return nil, err
	}
	generated, err := wilds.GenerateRegion(wilds.Epoch{WorldSeed: seed, RegionID: region, GeneratorVersion: version, Season: season})
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO region_epochs(id,world_id,region_id,world_seed,generator_version,season,starts_at,ends_at) VALUES(?,?,?,?,?,?,?,?)", id, world, region, seed, version, season, starts, ends); err != nil {
		return nil, err
	}
	for _, chunk := range generated.Chunks {
		m := wilds.ToProto(chunk, id)
		if err = chunks.Validate(m); err != nil {
			return nil, fmt.Errorf("generated chunk %d,%d: %w", chunk.CX, chunk.CY, err)
		}
		blob, err := proto.Marshal(m)
		if err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO wilds_chunks(epoch_id,layer,cx,cy,generator_version,blob,created_at) VALUES(?,0,?,?,?,?,?)", id, chunk.CX, chunk.CY, version, blob, now); err != nil {
			return nil, err
		}
	}
	return scanEpochRow(tx.QueryRowContext(ctx, epochSelect+"WHERE id=?", id))
}

func deleteStaleEpochs(ctx context.Context, tx *sql.Tx, world, region, season string, version int) error {
	const stale = "(SELECT id FROM region_epochs WHERE world_id=? AND region_id=? AND season=? AND generator_version!=?)"
	for _, table := range []string{"entity_state", "personal_claims", "discoveries", "lanterns"} {
		if _, err := tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE epoch IN "+stale, world, region, season, version); err != nil {
			return err
		}
	}
	_, err := tx.ExecContext(ctx, "DELETE FROM region_epochs WHERE world_id=? AND region_id=? AND season=? AND generator_version!=?", world, region, season, version)
	return err
}

// Chunk reads one stored chunk of an epoch in the caller's world. Another
// world's epoch, an epoch of another generator version and a missing chunk
// are all sql.ErrNoRows; an ended epoch is chunks.ErrEpochEnded.
func (c *Chunks) Chunk(ctx context.Context, tx *sql.Tx, world, epoch string, layer, cx, cy int32) (*contract.WildsChunk, error) {
	var owner string
	var version int
	var ends sql.NullInt64
	err := tx.QueryRowContext(ctx, "SELECT world_id,generator_version,ends_at FROM region_epochs WHERE id=?", epoch).Scan(&owner, &version, &ends)
	if err != nil {
		return nil, err
	}
	if owner != world || version != c.version() {
		return nil, sql.ErrNoRows
	}
	if ends.Valid && ends.Int64 <= c.now() {
		return nil, chunks.ErrEpochEnded
	}
	key := chunkKey{epoch, layer, cx, cy}
	if m := c.get(key); m != nil {
		return proto.Clone(m).(*contract.WildsChunk), nil
	}
	var blob []byte
	if err = tx.QueryRowContext(ctx, "SELECT blob FROM wilds_chunks WHERE epoch_id=? AND layer=? AND cx=? AND cy=?", epoch, layer, cx, cy).Scan(&blob); err != nil {
		return nil, err
	}
	m := &contract.WildsChunk{}
	if err = proto.Unmarshal(blob, m); err != nil {
		return nil, err
	}
	c.put(key, m)
	return proto.Clone(m).(*contract.WildsChunk), nil
}

func (c *Chunks) version() int {
	if c.GeneratorVersion != 0 {
		return c.GeneratorVersion
	}
	return content.WildsRules.GeneratorVersion
}

func (c *Chunks) now() int64 {
	if c.Now == nil {
		return time.Now().Unix()
	}
	return c.Now().Unix()
}

func (c *Chunks) get(k chunkKey) *contract.WildsChunk {
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

func (c *Chunks) put(k chunkKey, m *contract.WildsChunk) {
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

func regionDef(id string) (content.WildsRegion, bool) {
	for _, r := range content.WildsRules.Regions {
		if r.ID == id {
			return r, true
		}
	}
	return content.WildsRegion{}, false
}
