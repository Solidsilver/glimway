package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/store"
	"net/http"
	"slices"
	"strings"
	"time"
)

// The Hearthwick Library: one shared donation shelf per world. Donations are
// a social act, not a play mutation: no lease, no revision, no ledger. The
// first donor of a paper keeps the credit; the Keepers' starting shelf is
// client content and never stored server-side.
type shelfEntry struct {
	PaperID   string `json:"paperId"`
	DonatedBy string `json:"donatedBy"`
	DonatedAt string `json:"donatedAt"`
}

// donorNameCap matches the client's own trim of a display name.
const donorNameCap = 60

func capDonor(name string) string {
	r := []rune(strings.TrimSpace(name))
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
	rows, err := tx.QueryContext(ctx, "SELECT s.paper_id,p.display_name,s.donated_at FROM library_shelves s JOIN players p ON p.habitica_id=s.donor_id WHERE s.world_id=? ORDER BY s.donated_at,s.paper_id", world)
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
	rows, err := tx.QueryContext(ctx, "SELECT s.paper_id,p.display_name,s.donated_at FROM library_shelves s JOIN players p ON p.habitica_id=s.donor_id WHERE s.world_id=? AND s.paper_id=?", world, paperID)
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
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Shelves []shelfEntry `json:"shelves"`
	}{s, shelves})
}

func (a *Server) libraryDonate(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		PaperID string `json:"paperId"`
		Key     string `json:"key"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.Config.Now().Unix()
	hash, prior, err := idem(ctx, tx, s.HabiticaID, r.URL.Path, req.Key, req, now)
	if err != nil {
		return err
	}
	if prior != "" {
		return a.finish(w, r, tx, json.RawMessage(prior))
	}
	paper, known := content.PapersByID[req.PaperID]
	if !known {
		return fail(422, "unknown-paper")
	}
	if paper.Source == "library-start" {
		return fail(409, "already-shelved")
	}
	// The server only trusts its own stored progress: a find is the story
	// flag paper:<id>, uploaded before the client asks to donate.
	if !slices.Contains(s.State.Flags, "paper:"+req.PaperID) {
		return fail(403, "not-held")
	}
	res, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO library_shelves(world_id,paper_id,donor_id,donated_at) VALUES(?,?,?,?)", s.WorldID, req.PaperID, s.HabiticaID, now)
	if err != nil {
		return err
	}
	won, err := res.RowsAffected()
	if err != nil {
		return err
	}
	entry, err := shelvedEntry(ctx, tx, s.WorldID, req.PaperID)
	if err != nil {
		return err
	}
	if won != 1 {
		// Someone in this world shelved it first; they keep the credit.
		write(w, 409, struct {
			Error map[string]string `json:"error"`
			Entry *shelfEntry       `json:"entry"`
		}{map[string]string{"code": "already-shelved"}, &entry})
		return nil
	}
	v := struct {
		Entry shelfEntry `json:"entry"`
	}{entry}
	if err = saveIdem(ctx, tx, s.HabiticaID, r.URL.Path, req.Key, hash, v, now); err != nil {
		return err
	}
	return a.finish(w, r, tx, v)
}
