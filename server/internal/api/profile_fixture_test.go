package api

import (
	"encoding/json"
	"glimway/server/internal/rules"
	"math"
)

// profileBody prepares an acknowledged safe-boundary fixture for XP/profile tests.
// Report ordering and budget are exercised separately through real HTTP reports.
func (x *rig) profileBody(s response, p rules.Profile, doc rules.State) map[string]any {
	x.t.Helper()
	var client, generation string
	var seq, basis float64
	err := x.db.DB.QueryRow("SELECT report_client,report_generation,report_seq,(SELECT version FROM players WHERE account_id=v.account_id) FROM player_vitals v WHERE account_id=?", s.AccountID).Scan(&client, &generation, &seq, &basis)
	if err != nil {
		x.t.Fatal(err)
	}
	if _, err = x.db.DB.Exec("UPDATE player_vitals SET report_seq=?,report_basis=? WHERE account_id=?", seq+1, basis, s.AccountID); err != nil {
		x.t.Fatal(err)
	}
	if _, err = x.db.DB.Exec("UPDATE player_place SET area=?,x=?,y=? WHERE account_id=?", doc.Area, doc.Position.X, doc.Position.Y, s.AccountID); err != nil {
		x.t.Fatal(err)
	}
	class := ""
	if p.Class != nil {
		class = *p.Class
	}
	half := math.Floor(math.Min(100, p.Level) / 2)
	raw := map[string]any{"_id": p.ID, "profile": map[string]any{"name": p.Name}, "flags": map[string]any{"classSelected": p.Class != nil}, "stats": map[string]any{"lvl": p.Level, "exp": p.Exp, "hp": p.HP, "mp": p.MP, "class": class, "str": p.Stats.Str - half, "int": p.Stats.Int - half, "con": p.Stats.Con - half, "per": p.Stats.Per - half}, "items": map[string]any{"gear": map[string]any{"equipped": p.Equipped}}}
	// Copy as raw JSON so fixture mutations continue to exercise strict decoding.
	b, _ := json.Marshal(raw)
	return map[string]any{"lease": s.Lease, "raw": json.RawMessage(b), "report": map[string]any{"client": client, "generation": generation, "seq": seq + 1}}
}
