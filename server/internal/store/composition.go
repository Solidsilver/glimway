package store

import (
	"context"
	"database/sql"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// StateComposition is the handoff to B's normalized state loader and saver.
// Load and Persist keep the transaction boundary in the op helper. Persist
// now is Unix seconds. Persist must use BumpVersion once, after applying all of an operation's writes.
type StateComposition interface {
	Load(ctx context.Context, tx *sql.Tx, account string) (Snapshot, error)
	Persist(ctx context.Context, tx *sql.Tx, snapshot *Snapshot, now int64) error
	PlayerState(ctx context.Context, tx *sql.Tx, snapshot Snapshot) (*contract.PlayerState, error)
}

type DefaultStateComposition struct{}

func (DefaultStateComposition) Load(ctx context.Context, tx *sql.Tx, id string) (Snapshot, error) {
	return Load(ctx, tx, id)
}
func (DefaultStateComposition) Persist(ctx context.Context, tx *sql.Tx, s *Snapshot, now int64) error {
	return Persist(ctx, tx, s, now)
}
func (DefaultStateComposition) PlayerState(ctx context.Context, tx *sql.Tx, s Snapshot) (*contract.PlayerState, error) {
	return PlayerState(ctx, tx, s)
}

// PlayerState projects the retained document while B builds migration 028 and
// state.go. There is already only one authoritative version: players.version.
func PlayerState(ctx context.Context, tx *sql.Tx, s Snapshot) (*contract.PlayerState, error) {
	out := &contract.PlayerState{
		Version: float64(s.Version),
		Account: &contract.Account{AccountId: s.AccountID, DisplayName: s.DisplayName, ProfileSource: s.ProfileSource, WorldId: s.WorldID, Flagged: s.Flagged},
		Vitals:  &contract.Vitals{Hp: s.State.HP, Mana: s.State.Mana, MaxHp: s.State.MaxHP, MaxMana: s.State.MaxMana},
		Place:   &contract.Place{Area: s.State.Area, X: s.State.Position.X, Y: s.State.Position.Y},
		Story:   &contract.Story{Quests: map[string]string{}, Marks: s.State.Flags, Discoveries: s.State.Discoveries, Defeated: s.State.DefeatedEnemies, QuestItems: questInventory(s.State.Inventory), PlaySeconds: s.State.PlaySeconds},
		Embers:  &contract.Embers{Balance: float64(s.State.Embers), XpEarned: float64(s.State.XPEmbers), Pending: float64(s.Pending), XpMark: s.State.EmberXP, VerifiedXp: s.VerifiedXP},
	}
	if s.HabiticaPartyID != nil {
		out.Account.PartyId = wrapperspb.String(*s.HabiticaPartyID)
	}
	if s.State.Quest != "new" {
		out.Story.Quests["lantern-road"] = s.State.Quest
	}
	if s.ImportedProfile != nil {
		out.Profile = projectProfile(*s.ImportedProfile)
	}
	// Reports do not use the old document. Its seq is available before B lands.
	err := tx.QueryRowContext(ctx, "SELECT report_seq,report_client,report_generation,vitals_set_version,vitals_at,cast_ready_at FROM player_vitals WHERE account_id=?", s.AccountID).Scan(&out.Vitals.ReportSeq, &out.Vitals.ReportClient, &out.Vitals.ReportGeneration, &out.Vitals.VitalsSetVersion, &out.Vitals.VitalsAt, &out.Vitals.CastReadyAt)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	if err = tx.QueryRowContext(ctx, "SELECT place_set_version FROM player_place WHERE account_id=?", s.AccountID).Scan(&out.Place.PlaceSetVersion); err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	return out, nil
}

func projectProfile(p rules.Profile) *contract.HabiticaProfile {
	text := func(v *string) *wrapperspb.StringValue {
		if v == nil {
			return nil
		}
		return wrapperspb.String(*v)
	}
	gear := func(src map[string]*string) map[string]*structpb.Value {
		out := map[string]*structpb.Value{}
		for key, value := range src {
			if value == nil {
				out[key] = structpb.NewNullValue()
			} else {
				out[key] = structpb.NewStringValue(*value)
			}
		}
		return out
	}
	a := p.Appearance
	return &contract.HabiticaProfile{Id: p.ID, Name: p.Name, Class: text(p.Class), Level: p.Level, Exp: p.Exp, Hp: p.HP, MaxHp: p.MaxHP, Mp: p.MP, MaxMp: p.MaxMP,
		Stats: &contract.HabiticaStats{Str: p.Stats.Str, Int: p.Stats.Int, Con: p.Stats.Con, Per: p.Stats.Per}, Equipped: gear(p.Equipped), Costume: gear(p.Costume), Pets: p.Pets, Mounts: p.Mounts, UseCostume: p.UseCostume, SelectedPet: text(p.SelectedPet), SelectedMount: text(p.SelectedMount), PartyId: text(p.PartyID),
		Appearance: &contract.ProfileAppearance{Size: a.Size, Shirt: a.Shirt, Skin: a.Skin, HairColor: a.HairColor, HairStyle: a.HairStyle, Background: a.Background, HairBangs: a.HairBangs, HairMustache: a.HairMustache, HairBeard: a.HairBeard, HairFlower: a.HairFlower}}
}
