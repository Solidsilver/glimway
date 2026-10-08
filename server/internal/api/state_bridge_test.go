package api

import (
	"encoding/json"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
)

// Domain tests keep their convenient Snapshot assertions while login/play/state
// use PlayerState on the wire. New contract tests inspect the raw response.
func testSnapshotJSON(raw []byte) []byte {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return raw
	}
	var stateFields map[string]json.RawMessage
	if json.Unmarshal(fields["state"], &stateFields) != nil || stateFields["account"] == nil {
		return raw
	}
	var p contract.PlayerState
	if protojson.Unmarshal(fields["state"], &p) != nil {
		return raw
	}
	s := store.Snapshot{Version: int64(p.Version), AccountID: p.Account.AccountId, DisplayName: p.Account.DisplayName, WorldID: p.Account.WorldId, ProfileSource: p.Account.ProfileSource, Flagged: p.Account.Flagged, VitalsSource: "imported", State: rules.NewState(), Pending: int(p.Embers.Pending), VerifiedXP: p.Embers.VerifiedXp}
	if p.Account.PartyId != nil {
		s.HabiticaPartyID = &p.Account.PartyId.Value
	}
	if profile := stateFields["profile"]; string(profile) != "null" {
		var imported rules.Profile
		if json.Unmarshal(profile, &imported) == nil {
			s.ImportedProfile = &imported
		}
	}
	s.State.HP = p.Vitals.Hp
	s.State.Mana = p.Vitals.Mana
	s.State.MaxHP = p.Vitals.MaxHp
	s.State.MaxMana = p.Vitals.MaxMana
	s.State.Area = p.Place.Area
	s.State.Position = rules.Position{X: p.Place.X, Y: p.Place.Y}
	if step := p.Story.Quests["lantern-road"]; step != "" {
		s.State.Quest = step
	}
	s.State.Flags = append([]string{}, p.Story.Marks...)
	s.State.Discoveries = append([]string{}, p.Story.Discoveries...)
	s.State.DefeatedEnemies = append([]string{}, p.Story.Defeated...)
	s.State.Inventory = append([]string{}, p.Story.QuestItems...)
	s.State.PlaySeconds = p.Story.PlaySeconds
	s.State.Embers = int(p.Embers.Balance)
	s.State.XPEmbers = int(p.Embers.XpEarned)
	s.State.EmberXP = p.Embers.XpMark
	var projected map[string]json.RawMessage
	_ = json.Unmarshal([]byte(store.JSON(s)), &projected)
	for k, v := range projected {
		fields[k] = v
	}
	out, _ := json.Marshal(fields)
	return out
}
