package api

import (
	"glimway/server/internal/store"
	"net/http"
)

func (a *Server) state(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	l := r.Header.Get("X-Play-Lease")
	active := l != "" && s.LeaseID.Valid && l == s.LeaseID.String
	if active {
		if _, err = tx.ExecContext(r.Context(), "UPDATE players SET lease_seen_at=? WHERE habitica_id=?", a.Config.Now().Unix(), s.HabiticaID); err != nil {
			return err
		}
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		LeaseActive bool `json:"leaseActive"`
	}{s, active})
}

func (a *Server) play(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		ClientID string `json:"clientId"`
		TakeOver bool   `json:"takeOver"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	if req.ClientID == "" || len(req.ClientID) > 128 {
		return fail(400, "invalid-client")
	}
	tx, s, hash, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	client := hash + ":" + req.ClientID
	now := a.Config.Now().Unix()
	lease := s.LeaseID.String
	if s.LeaseID.Valid && s.LeaseClient.String != client && now-s.LeaseSeen.Int64 < 120 && !req.TakeOver {
		return fail(409, "playing-elsewhere")
	}
	if !s.LeaseID.Valid || s.LeaseClient.String != client {
		lease, err = store.Random()
		if err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE players SET lease_id=?,lease_client=?,lease_seen_at=? WHERE habitica_id=?", lease, client, now, s.HabiticaID); err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Lease string `json:"lease"`
	}{s, lease}, func() { a.presenceChanged(s.HabiticaID) })
}
