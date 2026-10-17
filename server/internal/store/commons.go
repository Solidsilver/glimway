package store

// Common ways (roadmap 0.13; lamps.md 2.4): laid paths outside a hold are
// Common, kept by presence. A player standing in a generated chunk flags it
// visited once for the calendar wick (Visit); the turning reads the flags
// once, beside the holds' judgement, through the server's Commons.

import (
	"context"
	"database/sql"

	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
)

// Commons judges Common work at the turning, in the turning's transaction,
// after the holds are judged and before the ended wick is cleaned up.
type Commons interface {
	// Turn carries ended's Common work onto next (the new wick epoch) or
	// turns it, refunding what was paid. ended is the newest wick epoch
	// that ended at or before next began (nil: none was made); lapsed are
	// the holds that went at this turning, whose land turns with next.
	Turn(ctx context.Context, tx *sql.Tx, world string, ended, next *contract.WildsEpoch, lapsed []Hold, now int64) error
}

// WickStart is the calendar wick holding now: its start, the key a visit
// is flagged under.
func WickStart(now int64) int64 { return content.CalendarAt(content.CalendarRules, now).StartsAt }

// Visit flags the chunk visited this calendar wick. The first one is
// written; any other is a no-op.
func Visit(ctx context.Context, tx *sql.Tx, world string, cx, cy int, now int64) error {
	_, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO chunk_visits(world_id,realm,layer,cx,cy,wick_start,first_at) VALUES(?,?,0,?,?,?,?)", world, content.WildsRules.GetRealm(), cx, cy, WickStart(now), now)
	return err
}

// Visited: someone has stood in the chunk during the calendar wick holding
// now, so its Common work carries through the coming turning.
func Visited(ctx context.Context, tx *sql.Tx, world string, cx, cy int, now int64) (bool, error) {
	var seen bool
	err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM chunk_visits WHERE world_id=? AND realm=? AND layer=0 AND cx=? AND cy=? AND wick_start=?)", world, content.WildsRules.GetRealm(), cx, cy, WickStart(now)).Scan(&seen)
	return seen, err
}

// VisitedThrough: someone stood in the chunk during every calendar wick
// from the one holding from up to (not including) the one holding to. A
// turning the server missed (down, or nobody came) is judged in order: a
// wick without a visit turns the chunk's Common work, whatever came after.
func VisitedThrough(ctx context.Context, tx *sql.Tx, world string, cx, cy int, from, to int64) (bool, error) {
	end := WickStart(to)
	for t := WickStart(from); t < end; {
		var seen bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM chunk_visits WHERE world_id=? AND realm=? AND layer=0 AND cx=? AND cy=? AND wick_start=?)", world, content.WildsRules.GetRealm(), cx, cy, t).Scan(&seen); err != nil || !seen {
			return false, err
		}
		next := content.CalendarAt(content.CalendarRules, t).NextTurning
		if next <= t {
			break
		}
		t = next
	}
	return true, nil
}

// trimVisits drops the flags of wicks before the one starting at wickStart:
// the turning has read them.
func trimVisits(ctx context.Context, tx *sql.Tx, world string, wickStart int64) error {
	_, err := tx.ExecContext(ctx, "DELETE FROM chunk_visits WHERE world_id=? AND wick_start<?", world, wickStart)
	return err
}

// endedWick is the world's newest wick epoch that ended at or before e
// began, or nil.
func endedWick(ctx context.Context, tx *sql.Tx, world string, e *contract.WildsEpoch) (*contract.WildsEpoch, error) {
	v, err := scanEpochRow(tx.QueryRowContext(ctx, epochSelect+"WHERE world_id=? AND kind='wick' AND id!=? AND ends_at<=? ORDER BY starts_at DESC LIMIT 1", world, e.Id, int64(e.StartsAt)))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return v, err
}
