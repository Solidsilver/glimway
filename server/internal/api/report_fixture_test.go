package api

import (
	"context"
	"encoding/json"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
	"net/http"
)

// flushFixtureReport models the client flushing combat before a vitals operation.
func (x *rig) flushFixtureReport(c *http.Cookie, op map[string]any) {
	x.t.Helper()
	if op["report"] != nil {
		return
	}
	var id string
	if err := x.db.DB.QueryRow("SELECT account_id FROM sessions WHERE id_hash=?", store.Hash(c.Value)).Scan(&id); err != nil {
		return
	}
	tx, err := x.db.DB.Begin()
	if err != nil {
		x.t.Fatal(err)
	}
	s, err := store.Load(context.Background(), tx, id)
	if err != nil {
		tx.Rollback()
		x.t.Fatal(err)
	}
	var client, generation string
	var seq float64
	err = tx.QueryRow("SELECT report_client,report_generation,report_seq FROM player_vitals WHERE account_id=?", id).Scan(&client, &generation, &seq)
	tx.Rollback()
	if err != nil {
		x.t.Fatal(err)
	}
	req := &contract.ReportRequest{Lease: op["lease"].(string), Client: client, Generation: generation, Seq: seq + 1, Basis: float64(s.Version), Hp: s.State.HP, Mana: s.State.Mana, Place: &contract.Where{Area: s.State.Area, X: s.State.Position.X, Y: s.State.Position.Y}}
	raw, _ := protojson.Marshal(req)
	w := x.rawHTTP("POST", "/api/report", json.RawMessage(raw), c)
	if w.Code != 200 {
		return
	}
	op["report"] = map[string]any{"client": client, "generation": generation, "seq": seq + 1}
}

// reportState sends the fixture's live combat sample through the real report route.
func (x *rig) reportState(c *http.Cookie, s response, hp, mana float64, where map[string]any) response {
	x.t.Helper()
	var client, gen string
	var seq, basis float64
	if err := x.db.DB.QueryRow("SELECT report_client,report_generation,report_seq,version FROM player_vitals JOIN players USING(account_id) WHERE account_id=?", s.AccountID).Scan(&client, &gen, &seq, &basis); err != nil {
		x.t.Fatal(err)
	}
	out := x.expect("POST", "/api/report", map[string]any{"lease": s.Lease, "client": client, "generation": gen, "seq": seq + 1, "basis": basis, "hp": hp, "mana": mana, "casts": 0, "place": where}, c, 200)
	out.Lease = s.Lease
	return out
}
