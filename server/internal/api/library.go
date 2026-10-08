package api

import (
	"context"
	"database/sql"
	"glimway/content"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"net/http"
	"slices"
	"strings"
	"time"
)

// The Hearthwick Library has one shared donation shelf per world. Donations
// are keyed play operations; the first donor keeps the credit.
type shelfEntry struct {
	PaperID   string `json:"paperId"`
	DonatedBy string `json:"donatedBy"`
	DonatedAt string `json:"donatedAt"`
}

// donorNameCap matches the client's own trim of a display name.
const donorNameCap = 60

func capDonor(name string) string {
	r := []rune(strings.TrimSpace(name))
	if len(r) == 0 {
		return "A Keeper"
	}
	if len(r) > donorNameCap {
		r = r[:donorNameCap]
	}
	return string(r)
}

func scanShelfEntry(rows *sql.Rows) (shelfEntry, error) {
	var e shelfEntry
	var at int64
	if err := rows.Scan(&e.PaperID, &e.DonatedBy, &at); err != nil {
		return e, err
	}
	e.DonatedBy = capDonor(e.DonatedBy)
	e.DonatedAt = time.Unix(at, 0).UTC().Format(time.RFC3339)
	return e, nil
}

// worldShelf reads a world's donations, oldest first, credited with the
// donor's current display name, capped.
func worldShelf(ctx context.Context, tx *sql.Tx, world string) ([]shelfEntry, error) {
	rows, err := tx.QueryContext(ctx, "SELECT s.paper_id,p.display_name,s.donated_at FROM library_shelves s JOIN players p ON p.account_id=s.donor_id WHERE s.world_id=? ORDER BY s.donated_at,s.paper_id", world)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	shelves := []shelfEntry{}
	for rows.Next() {
		e, err := scanShelfEntry(rows)
		if err != nil {
			return nil, err
		}
		shelves = append(shelves, e)
	}
	return shelves, rows.Err()
}

// shelvedEntry reads the one donation of a paper in a world (the winner's).
func shelvedEntry(ctx context.Context, tx *sql.Tx, world, paperID string) (shelfEntry, error) {
	rows, err := tx.QueryContext(ctx, "SELECT s.paper_id,p.display_name,s.donated_at FROM library_shelves s JOIN players p ON p.account_id=s.donor_id WHERE s.world_id=? AND s.paper_id=?", world, paperID)
	if err != nil {
		return shelfEntry{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		return shelfEntry{}, rows.Err()
	}
	return scanShelfEntry(rows)
}

func (a *Server) libraryRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	shelves, err := worldShelf(r.Context(), tx, s.WorldID)
	if err != nil {
		return err
	}
	return a.finishRead(w, r, tx, s, struct {
		Shelves []shelfEntry `json:"shelves"`
	}{shelves})
}

func (a *Server) libraryDonate(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mutation
		PaperID string `json:"paperId"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		paper, known := content.PapersByID[req.PaperID]
		if !known {
			return nil, fail(422, "unknown-paper")
		}
		if paper.Source == "library-start" {
			return nil, fail(409, "already-shelved")
		}
		if s.State.Area != "village" {
			return nil, fail(409, "wrong-area")
		}
		if !slices.Contains(s.State.Flags, "paper:"+req.PaperID) {
			return nil, fail(403, "not-held")
		}
		res, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO library_shelves(world_id,paper_id,donor_id,donated_at) VALUES(?,?,?,?)", s.WorldID, req.PaperID, s.AccountID, now)
		if err != nil {
			return nil, err
		}
		won, err := res.RowsAffected()
		if err != nil {
			return nil, err
		}
		if won != 1 {
			return nil, fail(409, "already-shelved")
		}
		entry, err := shelvedEntry(ctx, tx, s.WorldID, req.PaperID)
		if err != nil {
			return nil, err
		}
		s.State.Flags = rules.AddUnique(s.State.Flags, "donated:"+req.PaperID+"@"+time.Unix(now, 0).UTC().Format("2006-01-02"))
		return struct {
			Entry shelfEntry `json:"entry"`
		}{entry}, nil
	})
}
