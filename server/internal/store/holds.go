package store

// Holds (roadmap 0.12; location-seam.md §0 #2, #8; hearthwick-2.md §6): a
// generated wick chunk pinned to one wick epoch across turnings, so its
// terrain, layout and ground changes stay put. The chunk composer's order is
// fixed → held → generated: a held chunk is served from its pinned epoch's
// stored blob (Chunk), and a chunk made beside it keeps its edge as it keeps
// the Tangle's (make, wilds.Kept.Held).
//
// Holds are judged once, at the turning (roadmap rule 4): when a new wick
// epoch is made, each hold's holder kind says whether it keeps. A hold that
// lapses, or was released during the wick, goes then, and its chunk turns
// with the new epoch. Nothing turns mid-wick, so a released chunk never
// meets neighbours made beside its held edge.

import (
	"context"
	"database/sql"
	"errors"
	"strconv"

	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/frontier"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/wilds"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// ErrHeld: the chunk is held by another holder.
var ErrHeld = errors.New("chunk held")

// ErrNotHoldable: only a generated wick chunk of the Beyond inside the
// frontier can be held, by a named holder kind. A footprint's (the
// Whitequiet's) carries this wick's story sites, which turn.
var ErrNotHoldable = errors.New("chunk not holdable")

// Hold is one held chunk (realm the Wilds', layer 0): the epoch it is pinned
// to, its holder (a kind, e.g. "lot-lantern", and an id, e.g. the lot) and
// when it began. Released, when set, is when the holder let it go; it turns
// at the next turning.
type Hold struct {
	World      string
	CX, CY     int32
	Epoch      string
	HolderKind string
	HolderID   string
	Since      int64
	Released   *int64
}

// Holder judges one holder kind's holds at the turning.
type Holder interface {
	// Keeps: does the hold last through this turning (a lot lantern: is
	// it lit)? It may spend the upkeep in tx.
	Keeps(ctx context.Context, tx *sql.Tx, h Hold, now int64) (bool, error)
	// Released runs in the turning's transaction once the hold has gone,
	// before its chunk turns. Nothing a player placed may be lost (roadmap
	// rule 3): the lot-lantern lane sends the pieces placed on the chunk
	// home here (hearthwick-2.md §6).
	Released(ctx context.Context, tx *sql.Tx, h Hold, now int64) error
}

const holdSelect = "SELECT world_id,cx,cy,epoch_id,holder_kind,holder_id,since,released_at FROM holds "

func scanHold(row interface{ Scan(...any) error }) (Hold, error) {
	var h Hold
	var released sql.NullInt64
	if err := row.Scan(&h.World, &h.CX, &h.CY, &h.Epoch, &h.HolderKind, &h.HolderID, &h.Since, &released); err != nil {
		return Hold{}, err
	}
	if released.Valid {
		h.Released = &released.Int64
	}
	return h, nil
}

// chunkName is a chunk's key in world_changes ("<cx>:<cy>", as the API
// writes it).
func chunkName(cx, cy int32) string {
	return strconv.Itoa(int(cx)) + ":" + strconv.Itoa(int(cy))
}

// HoldAt is the hold on a chunk, or nil.
func (c *Chunks) HoldAt(ctx context.Context, tx *sql.Tx, world string, cx, cy int32) (*Hold, error) {
	h, err := scanHold(tx.QueryRowContext(ctx, holdSelect+"WHERE world_id=? AND realm=? AND layer=0 AND cx=? AND cy=?", world, content.WildsRules.GetRealm(), cx, cy))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &h, nil
}

// Holds are the world's holds, row by row.
func (c *Chunks) Holds(ctx context.Context, tx *sql.Tx, world string) ([]Hold, error) {
	rows, err := tx.QueryContext(ctx, holdSelect+"WHERE world_id=? AND realm=? AND layer=0 ORDER BY cy,cx", world, content.WildsRules.GetRealm())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Hold
	for rows.Next() {
		h, err := scanHold(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// Hold pins a generated wick chunk to the current wick epoch for a holder,
// making the chunk if it hasn't been. Its ground changes stop expiring with
// the wick. Holding it again for the same holder answers the hold (and takes
// back a release); for another holder it is ErrHeld.
func (c *Chunks) Hold(ctx context.Context, tx *sql.Tx, world string, cx, cy int32, kind, id string, now int64) (Hold, error) {
	x, y := int(cx), int(cy)
	if err := confirmReach(ctx, tx, world); err != nil {
		return Hold{}, err
	}
	if kind == "" || location.SourceOf(x, y).Kind != location.SourceGenerated || wilds.EpochKindAt(x, y) != EpochWick || wilds.FootprintAt(x, y) != nil || !frontier.Inside(world, x, y) {
		return Hold{}, ErrNotHoldable
	}
	have, err := c.HoldAt(ctx, tx, world, cx, cy)
	if err != nil {
		return Hold{}, err
	}
	if have != nil {
		if have.HolderKind != kind || have.HolderID != id {
			return Hold{}, ErrHeld
		}
		if _, err = tx.ExecContext(ctx, "UPDATE holds SET released_at=NULL WHERE world_id=? AND realm=? AND layer=0 AND cx=? AND cy=?", world, content.WildsRules.GetRealm(), cx, cy); err != nil {
			return Hold{}, err
		}
		have.Released = nil
		return *have, nil
	}
	e, err := chunks.Epoch(ctx, tx, c, world, EpochWick, now)
	if err != nil {
		return Hold{}, err
	}
	// A request from before the turning that got its lock after it: the
	// next wick's chunks may be made already, not mirroring this one.
	if e.EndsAt != nil && e.EndsAt.Value <= float64(c.readNow(ctx)) {
		return Hold{}, chunks.ErrEpochEnded
	}
	if _, err = c.Chunk(ctx, tx, world, e.Id, 0, cx, cy); err != nil {
		return Hold{}, err
	}
	realm := content.WildsRules.GetRealm()
	if _, err = tx.ExecContext(ctx, "UPDATE world_changes SET ends_at=NULL WHERE world_id=? AND realm=? AND layer=0 AND chunk=? AND epoch=?", world, realm, chunkName(cx, cy), e.Id); err != nil {
		return Hold{}, err
	}
	h := Hold{World: world, CX: cx, CY: cy, Epoch: e.Id, HolderKind: kind, HolderID: id, Since: now}
	if _, err = tx.ExecContext(ctx, "INSERT INTO holds(world_id,realm,layer,cx,cy,epoch_id,holder_kind,holder_id,since) VALUES(?,?,0,?,?,?,?,?,?)", world, realm, cx, cy, e.Id, kind, id, now); err != nil {
		return Hold{}, err
	}
	// The new hold pushes the frontier out now (reach.go).
	return h, syncReach(ctx, tx, world)
}

// Release lets a hold go: its chunk stays as it is until the next turning,
// where the hold goes and the chunk turns with the new epoch. false when the
// chunk isn't held, or not by this holder.
func (c *Chunks) Release(ctx context.Context, tx *sql.Tx, world string, cx, cy int32, kind, id string, now int64) (bool, error) {
	res, err := tx.ExecContext(ctx, "UPDATE holds SET released_at=coalesce(released_at,?) WHERE world_id=? AND realm=? AND layer=0 AND cx=? AND cy=? AND holder_kind=? AND holder_id=?", now, world, content.WildsRules.GetRealm(), cx, cy, kind, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// judgeTurnings is the turning's judgement (roadmap rule 4), run once as a
// new wick epoch is made: every calendar turning since the world's cursor
// (wick_turnings) is judged once, in order. One the server missed (it was
// down, or nobody came) is judged at its own moment, so a store of oil
// burns a wick at each and a crate is dated by the turning that packed it;
// the newest, this epoch's, is judged now. A turning already judged (a new
// generator version's epoch for the same wick) judges nothing again. It
// answers every hold that went.
func (c *Chunks) judgeTurnings(ctx context.Context, tx *sql.Tx, world string, e *contract.WildsEpoch, now int64) ([]Hold, error) {
	start := int64(e.StartsAt)
	var through sql.NullInt64
	if err := tx.QueryRowContext(ctx, "SELECT judged_through FROM wick_turnings WHERE world_id=?", world).Scan(&through); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if through.Valid && through.Int64 >= start {
		return nil, nil
	}
	var gone []Hold
	if through.Valid {
		for b := content.CalendarAt(content.CalendarRules, through.Int64).NextTurning; b < start; {
			lapsed, err := c.judgeHolds(ctx, tx, world, b)
			if err != nil {
				return nil, err
			}
			gone = append(gone, lapsed...)
			next := content.CalendarAt(content.CalendarRules, b).NextTurning
			if next <= b {
				break
			}
			b = next
		}
	}
	lapsed, err := c.judgeHolds(ctx, tx, world, now)
	if err != nil {
		return nil, err
	}
	gone = append(gone, lapsed...)
	_, err = tx.ExecContext(ctx, "INSERT INTO wick_turnings(world_id,judged_through) VALUES(?,?) ON CONFLICT(world_id) DO UPDATE SET judged_through=excluded.judged_through", world, start)
	return gone, err
}

// judgeHolds is one turning's judgement, at that turning's moment now
// (judgeTurnings): a released hold goes; any other asks its holder kind
// whether it keeps. A hold that goes calls its holder's Released. A kind
// this server has no Holder for keeps, released or not: with no Released
// to send its placed pieces home, its land never turns (roadmap rule 3),
// and a release takes effect at the first turning a Holder for it is
// registered. It answers the holds that went.
func (c *Chunks) judgeHolds(ctx context.Context, tx *sql.Tx, world string, now int64) ([]Hold, error) {
	holds, err := c.Holds(ctx, tx, world)
	if err != nil {
		return nil, err
	}
	var gone []Hold
	for _, h := range holds {
		holder := c.Holders[h.HolderKind]
		if holder == nil {
			continue
		}
		keeps := h.Released == nil
		if keeps {
			if keeps, err = holder.Keeps(ctx, tx, h, now); err != nil {
				return nil, err
			}
		}
		if keeps {
			continue
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM holds WHERE world_id=? AND realm=? AND layer=0 AND cx=? AND cy=?", world, content.WildsRules.GetRealm(), h.CX, h.CY); err != nil {
			return nil, err
		}
		gone = append(gone, h)
		if err = holder.Released(ctx, tx, h, now); err != nil {
			return nil, err
		}
	}
	// What went takes its reach with it (reach.go).
	if len(gone) > 0 {
		if err = syncReach(ctx, tx, world); err != nil {
			return nil, err
		}
	}
	return gone, nil
}

// trimPinned keeps of an ended wick epoch that a hold pins only what the
// holds need: its held chunks and their ground changes. The epoch row stays
// (with what cascades from it) while any hold pins it.
func trimPinned(ctx context.Context, tx *sql.Tx, world string, wickStart int64) error {
	const pinned = "(SELECT id FROM wild_epochs WHERE world_id=? AND kind='wick' AND ends_at<?)"
	realm := content.WildsRules.GetRealm()
	if _, err := tx.ExecContext(ctx, `DELETE FROM wilds_chunks WHERE epoch_id IN `+pinned+` AND NOT EXISTS
 (SELECT 1 FROM holds h WHERE h.epoch_id=wilds_chunks.epoch_id AND h.realm=? AND h.layer=wilds_chunks.layer AND h.cx=wilds_chunks.cx AND h.cy=wilds_chunks.cy)`, world, wickStart, realm); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM world_changes WHERE world_id=? AND realm=? AND epoch IN `+pinned+` AND NOT EXISTS
 (SELECT 1 FROM holds h WHERE h.world_id=world_changes.world_id AND h.epoch_id=world_changes.epoch AND h.realm=world_changes.realm AND h.layer=world_changes.layer AND h.cx||':'||h.cy=world_changes.chunk)`, world, realm, world, wickStart)
	return err
}

// HeldEpochs are the epochs the world's held chunks are pinned to, by
// chunk: the composer's held source, for reads that cover many chunks.
func HeldEpochs(ctx context.Context, tx *sql.Tx, world string) (map[[2]int]*contract.WildsEpoch, error) {
	return heldEpochs(ctx, tx, "WHERE h.world_id=? AND h.realm=? AND h.layer=0", world, content.WildsRules.GetRealm())
}

// HeldEpoch is the epoch a held chunk is pinned to, or nil when it isn't
// held.
func HeldEpoch(ctx context.Context, tx *sql.Tx, world string, cx, cy int) (*contract.WildsEpoch, error) {
	held, err := heldEpochs(ctx, tx, "WHERE h.world_id=? AND h.realm=? AND h.layer=0 AND h.cx=? AND h.cy=?", world, content.WildsRules.GetRealm(), cx, cy)
	return held[[2]int{cx, cy}], err
}

// Pins: does a hold of the world pin the epoch?
func Pins(ctx context.Context, tx *sql.Tx, world, epoch string) (bool, error) {
	var pinned bool
	err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM holds WHERE world_id=? AND epoch_id=?)", world, epoch).Scan(&pinned)
	return pinned, err
}

func heldEpochs(ctx context.Context, tx *sql.Tx, where string, args ...any) (map[[2]int]*contract.WildsEpoch, error) {
	rows, err := tx.QueryContext(ctx, `SELECT h.cx,h.cy,e.id,e.world_seed,e.kind,e.generator_version,e.season,e.starts_at,e.ends_at
 FROM holds h JOIN wild_epochs e ON e.id=h.epoch_id `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[[2]int]*contract.WildsEpoch{}
	for rows.Next() {
		var cx, cy int
		var starts int64
		var ends sql.NullInt64
		e := &contract.WildsEpoch{}
		if err = rows.Scan(&cx, &cy, &e.Id, &e.WorldSeed, &e.Kind, &e.GeneratorVersion, &e.Season, &starts, &ends); err != nil {
			return nil, err
		}
		e.StartsAt = float64(starts)
		if ends.Valid {
			e.EndsAt = wrapperspb.Double(float64(ends.Int64))
		}
		out[[2]int{cx, cy}] = e
	}
	return out, rows.Err()
}
