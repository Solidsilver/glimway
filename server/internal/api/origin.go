package api

import (
	"encoding/json"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"math"
	"net/http"
	"slices"
)

func (a *Server) origin(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Choice string          `json:"choice"`
		Save   json.RawMessage `json:"save,omitempty"`
		Key    string          `json:"key"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	if req.Choice != "migrate" && req.Choice != "fresh" {
		return fail(400, "invalid-choice")
	}
	tx, s, sessionHash, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.Config.Now().Unix()
	hash, prior, err := idem(ctx, tx, s.HabiticaID, "origin", req.Key, req, now)
	if err != nil {
		return err
	}
	if prior != "" {
		return a.finish(w, r, tx, json.RawMessage(prior))
	}
	choice := "fresh"
	if req.Choice == "migrate" {
		choice = "migrated"
	}
	res, err := tx.ExecContext(ctx, "UPDATE players SET save_origin=?,save_origin_at=? WHERE habitica_id=? AND save_origin IS NULL", choice, now, s.HabiticaID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return fail(409, "already-set")
	}
	s.SaveOrigin = &choice
	var checkpoint string
	var originXP float64
	if err = tx.QueryRowContext(ctx, "SELECT checkpoint_json,checkpoint_xp FROM sessions WHERE id_hash=?", sessionHash).Scan(&checkpoint, &originXP); err != nil {
		return err
	}
	var p rules.Profile
	if err = json.Unmarshal([]byte(checkpoint), &p); err != nil {
		return err
	}
	s.State = rules.NewState()
	s.State.HP = math.Min(p.HP, p.MaxHP)
	s.State.MaxHP = p.MaxHP
	s.State.Mana = math.Min(p.MP, p.MaxMP)
	s.State.MaxMana = p.MaxMP
	s.State.EmberXP = originXP
	s.ImportedProfile = &p
	s.VitalsSource = "imported"
	if req.Choice == "migrate" {
		var save struct {
			State        json.RawMessage `json:"state"`
			VitalsSource string          `json:"vitalsSource"`
		}
		if json.Unmarshal(req.Save, &save) != nil || len(save.State) == 0 || (save.VitalsSource != "" && save.VitalsSource != "demo" && save.VitalsSource != "imported") {
			return fail(400, "invalid-save")
		}
		local, err := rules.DecodeProgress(save.State, 1e6, 1e6)
		if err != nil {
			return fail(400, "invalid-save")
		}
		hp, mana := s.State.HP, s.State.Mana
		s.State = rules.Merge(s.State, local, false)
		s.State.HP = hp
		s.State.Mana = mana
		if save.VitalsSource == "imported" {
			s.State.HP = math.Min(hp, local.HP)
			s.State.Mana = math.Min(mana, local.Mana)
		}
		var owned struct {
			Embers    float64  `json:"embers"`
			Flags     []string `json:"flags"`
			Inventory []string `json:"inventory"`
		}
		if json.Unmarshal(save.State, &owned) != nil || owned.Embers < 0 || math.IsNaN(owned.Embers) || math.IsInf(owned.Embers, 0) {
			return fail(400, "invalid-save")
		}
		gift := int(math.Min(math.Floor(owned.Embers), float64(rules.E.MigrationGiftCap)))
		if err = store.Credit(ctx, tx, &s, gift, 0, "migration", "guest-balance", nil, now); err != nil {
			return err
		}
		for _, f := range owned.Flags {
			valid := f == "embers:welcome" || f == "opened:"+rules.E.ChestID
			for _, id := range rules.E.RoadLanterns {
				valid = valid || f == "lit:"+id
			}
			if valid {
				if _, err = store.Outcome(ctx, tx, s.HabiticaID, f, "migration", now); err != nil {
					return err
				}
				s.State.Flags = rules.AddUnique(s.State.Flags, f)
			}
		}
		charm := slices.Contains(owned.Inventory, rules.E.CharmItem) || slices.Contains(owned.Flags, "opened:"+rules.E.ChestID)
		if charm {
			if err = grantOnce(ctx, tx, s.HabiticaID, rules.E.CharmItem, "migration-charm", now); err != nil {
				return err
			}
			if _, err = store.Outcome(ctx, tx, s.HabiticaID, "owned:"+rules.E.CharmItem, "migration", now); err != nil {
				return err
			}
			s.State.Inventory = rules.AddUnique(s.State.Inventory, rules.E.CharmItem)
		}
		for _, g := range []struct{ stage, event string }{{"guardian-defeated", "defeat-guardian"}, {"complete", "return-village"}} {
			if slices.Index(rules.Stages, s.State.Quest) >= slices.Index(rules.Stages, g.stage) {
				if _, err = store.Outcome(ctx, tx, s.HabiticaID, "quest-gift:"+g.event, "migration", now); err != nil {
					return err
				}
			}
		}
	}
	if err = store.Persist(ctx, tx, &s, now); err != nil {
		return err
	}
	if err = saveIdem(ctx, tx, s.HabiticaID, "origin", req.Key, hash, s, now); err != nil {
		return err
	}
	return a.finish(w, r, tx, s)
}
