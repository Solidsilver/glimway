package store

import (
	"context"
	"database/sql"
	"glimway/content"
	"slices"
)

// Queryer is a transaction or a database: the fall readers run inside a
// claim's or a wake's transaction, or straight on the database in tests.
type Queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// FallKey is a generated camp's fallen cycle (shared-fights.md 1.3): the
// fight room's full identity (world, realm, layer, chunk, epoch), the camp's
// entity id and the cycle its enemies belonged to.
type FallKey struct {
	World, Realm  string
	Layer, CX, CY int32
	Epoch, Entity string
	Cycle         int64
}

// FallRecord is one stored fall: when it fell (Unix milliseconds) and who
// witnessed it (account ids, sorted, unique).
type FallRecord struct {
	Key       FallKey
	FellAt    int64
	Witnesses []string
}

// CampAvailableAt is when a camp that fell at fellAt (Unix milliseconds)
// rises again for its next cycle, in Unix seconds (entity_state's clock).
// The respawn timer runs from the fall, never from a claim.
func CampAvailableAt(fellAt int64) int64 {
	return fellAt/1000 + int64(content.WildsRules.GetTimers().GetCampRespawnSeconds())
}

// InsertFall writes one fall in its own transaction: the record, its
// witnesses, and the camp's entity_state row, which the fall owns (cleared
// in this cycle until CampAvailableAt). It is idempotent: writing the same
// fall again adds only witnesses it lacked. The camp row never moves back
// to an older cycle. A fall whose epoch is gone is dropped (false): nothing
// can claim it any more. Witnesses with no player row are left out.
func (s *Store) InsertFall(ctx context.Context, f FallRecord) (bool, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	k := f.Key
	var epochs int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM wild_epochs WHERE id=?", k.Epoch).Scan(&epochs); err != nil {
		return false, err
	}
	if epochs == 0 {
		return false, nil
	}
	if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO fight_falls VALUES(?,?,?,?,?,?,?,?,?)", k.World, k.Realm, k.Layer, k.CX, k.CY, k.Epoch, k.Entity, k.Cycle, f.FellAt); err != nil {
		return false, err
	}
	for _, account := range f.Witnesses {
		if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO fight_fall_witnesses SELECT ?,?,?,?,?,?,?,?,account_id FROM players WHERE account_id=?`, k.World, k.Realm, k.Layer, k.CX, k.CY, k.Epoch, k.Entity, k.Cycle, account); err != nil {
			return false, err
		}
	}
	// The stored fell_at wins over a re-enqueued copy's, so the timer is
	// the first write's.
	var fellAt int64
	if err = tx.QueryRowContext(ctx, "SELECT fell_at FROM fight_falls WHERE world_id=? AND realm=? AND layer=? AND cx=? AND cy=? AND epoch=? AND entity_id=? AND cycle=?", k.World, k.Realm, k.Layer, k.CX, k.CY, k.Epoch, k.Entity, k.Cycle).Scan(&fellAt); err != nil {
		return false, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO entity_state(epoch,entity_id,cycle,state,available_at,by_id,at) VALUES(?,?,?,'cleared',?,NULL,?)
		ON CONFLICT(epoch,entity_id) DO UPDATE SET cycle=excluded.cycle,state='cleared',available_at=excluded.available_at,by_id=NULL,at=excluded.at
		WHERE entity_state.cycle<excluded.cycle OR (entity_state.cycle=excluded.cycle AND entity_state.state='available')`,
		k.Epoch, k.Entity, k.Cycle, CampAvailableAt(fellAt), fellAt/1000); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// ReadFall is the exact lookup of one camp's fall in one cycle: no
// projection, and a camp's availability is never read as proof.
func ReadFall(ctx context.Context, q Queryer, k FallKey) (FallRecord, bool, error) {
	f := FallRecord{Key: k, Witnesses: []string{}}
	err := q.QueryRowContext(ctx, "SELECT fell_at FROM fight_falls WHERE world_id=? AND realm=? AND layer=? AND cx=? AND cy=? AND epoch=? AND entity_id=? AND cycle=?", k.World, k.Realm, k.Layer, k.CX, k.CY, k.Epoch, k.Entity, k.Cycle).Scan(&f.FellAt)
	if err == sql.ErrNoRows {
		return FallRecord{}, false, nil
	}
	if err != nil {
		return FallRecord{}, false, err
	}
	rows, err := q.QueryContext(ctx, "SELECT account_id FROM fight_fall_witnesses WHERE world_id=? AND realm=? AND layer=? AND cx=? AND cy=? AND epoch=? AND entity_id=? AND cycle=? ORDER BY account_id", k.World, k.Realm, k.Layer, k.CX, k.CY, k.Epoch, k.Entity, k.Cycle)
	if err != nil {
		return FallRecord{}, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return FallRecord{}, false, err
		}
		f.Witnesses = append(f.Witnesses, id)
	}
	return f, true, rows.Err()
}

// Witnessed: the account is among that exact fall's witnesses.
func (f FallRecord) Witnessed(account string) bool {
	_, ok := slices.BinarySearch(f.Witnesses, account)
	return ok
}

// CampClaimed: the account has claimed this camp's fallen cycle.
func CampClaimed(ctx context.Context, q Queryer, epoch, entity string, cycle int64, account string) (bool, error) {
	var n int
	err := q.QueryRowContext(ctx, "SELECT count(*) FROM camp_claims WHERE epoch=? AND entity_id=? AND cycle=? AND account_id=?", epoch, entity, cycle, account).Scan(&n)
	return n > 0, err
}

// InsertCampClaim settles a fallen cycle for the account, once.
func InsertCampClaim(ctx context.Context, q Queryer, epoch, entity string, cycle int64, account string, at int64) error {
	_, err := q.ExecContext(ctx, "INSERT INTO camp_claims VALUES(?,?,?,?,?)", epoch, entity, cycle, account, at)
	return err
}
