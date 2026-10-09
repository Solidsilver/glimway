package api

import (
	contract "glimway/server/internal/gen/glimway/v1"
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
		if _, err = tx.ExecContext(r.Context(), "UPDATE players SET lease_seen_at=? WHERE account_id=?", a.Config.Now().Unix(), s.AccountID); err != nil {
			return err
		}
	}
	state, err := a.Config.State.PlayerState(r.Context(), tx, s)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, &contract.StateResponse{State: state, LeaseActive: active})
}

func (a *Server) play(w http.ResponseWriter, r *http.Request) error {
	var req contract.PlayRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	if !validClientID(req.ClientId) {
		return fail(400, "invalid-client")
	}
	tx, s, hash, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	client := hash + ":" + req.ClientId
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
	if _, err = tx.ExecContext(r.Context(), "UPDATE players SET lease_id=?,lease_client=?,lease_seen_at=? WHERE account_id=?", lease, client, now, s.AccountID); err != nil {
		return err
	}
	var generation string
	if s.LeaseID.Valid && s.LeaseClient.String == client {
		err = tx.QueryRowContext(r.Context(), "SELECT report_generation FROM player_vitals WHERE account_id=?", s.AccountID).Scan(&generation)
		if err != nil {
			return err
		}
	}
	if generation == "" {
		generation, err = store.Random()
	}
	if err != nil {
		return err
	}
	if s.LeaseClient.String != client || !s.LeaseID.Valid {
		// A new lease starts with the mount at home (docs/design/crafts.md
		// 3.3): it found its own way back while the tab was away.
		if _, err = tx.ExecContext(r.Context(), "UPDATE player_companions SET mount_out='' WHERE account_id=?", s.AccountID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(r.Context(), `INSERT INTO player_vitals(account_id,hp,mana,vitals_at,vitals_set_version,report_client,report_generation,cast_ready_at)
 VALUES(?,?,?,?,0,?,?,?) ON CONFLICT(account_id) DO UPDATE SET report_client=excluded.report_client,report_generation=excluded.report_generation,report_seq=0,report_at=NULL,report_basis=0,cast_ready_at=MAX(cast_ready_at,excluded.cast_ready_at)`, s.AccountID, s.State.HP, s.State.Mana, now, req.ClientId, generation, now); err != nil {
			return err
		}
	}
	if err = store.BumpVersion(r.Context(), tx, &s); err != nil {
		return err
	}
	state, err := a.Config.State.PlayerState(r.Context(), tx, s)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, &contract.PlayResponse{State: state, Lease: lease, ReportGeneration: generation, ReportClient: req.ClientId}, func() { a.presenceChanged(s.AccountID) })
}
