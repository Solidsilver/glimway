// Package story owns quest, mark, paper and Echo rules. Grants share the operation transaction.
package story

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/ports"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"slices"
	"sort"
	"strings"
	"time"
)

type Rules struct {
	Chunks chunks.ChunkSource
	Epochs chunks.EpochComposition
	Now    func() time.Time
}

func RoadLit(s store.Snapshot) bool {
	return content.QuestIndex("lantern-road", s.State.Quests["lantern-road"]) >= content.QuestIndex("complete")
}
func Mark(s *store.Snapshot, mark string) bool {
	added := !slices.Contains(s.State.Flags, mark)
	s.State.Flags = rules.AddUnique(s.State.Flags, mark)
	return added
}
func (r Rules) Grant(ctx context.Context, tx *sql.Tx, s *store.Snapshot, paper string, now int64) (ports.Grant, error) {
	p, ok := content.PapersByID[paper]
	if !ok || p.Rule.Unbuilt {
		return ports.Grant{}, fmt.Errorf("paper unavailable: %s", paper)
	}
	return ports.Grant{Paper: paper, Added: Mark(s, "paper:"+paper)}, nil
}
func (r Rules) Echoes(ctx context.Context, tx *sql.Tx, s store.Snapshot, in ports.EchoInput) ([]*contract.EchoAssignment, error) {
	out := []*contract.EchoAssignment{}
	if in.Epoch == nil {
		return out, nil
	}
	sites := append([]ports.EchoSite{}, in.Sites...)
	sort.Slice(sites, func(i, j int) bool { return sites[i].Site.Id < sites[j].Site.Id })
	east := int32(-1)
	for _, region := range content.WildsRules.Regions {
		if region.GetId() == in.Epoch.RegionId {
			east = int32(region.GetGridWidth()) - 1
		}
	}
	used := map[string]bool{}
	for _, site := range sites {
		if site.Site.Kind != contract.SiteKind_SITE_KIND_ECHO {
			continue
		}
		eligible := []content.Echo{}
		for _, e := range content.StoryRules.Echoes {
			if !used[e.Member] && (!e.Late || RoadLit(s)) && (!e.East || site.CX == east) {
				eligible = append(eligible, e)
			}
		}
		if len(eligible) == 0 {
			continue
		}
		pick := eligible[uint32(wilds.Hash(in.Epoch.WorldSeed, in.Epoch.RegionId, in.Epoch.Season, "echo", site.Site.Id))%uint32(len(eligible))]
		used[pick.Member] = true
		out = append(out, &contract.EchoAssignment{Site: site.Site.Id, Member: pick.Member, Settled: slices.Contains(s.State.Flags, "echo:"+pick.Member)})
	}
	return out, nil
}
func near(w *contract.Where, x, y float64) bool { dx, dy := w.X-x, w.Y-y; return dx*dx+dy*dy <= 32*32 }
func (r Rules) Eligible(ctx context.Context, tx *sql.Tx, s store.Snapshot, in ports.PaperInput) (bool, error) {
	p, ok := content.PapersByID[in.Paper]
	if !ok || p.Rule.Unbuilt || in.Where == nil {
		return false, nil
	}
	q := p.Rule
	w := in.Where
	if q.RoadLit && !RoadLit(s) || q.Paper != "" && !slices.Contains(s.State.Flags, "paper:"+q.Paper) {
		return false, nil
	}
	if q.Fact == "turned" || q.Fact == "board" {
		if !slices.Contains(s.State.Flags, "wilds:turned") {
			return false, nil
		}
	}
	switch p.Source {
	case "placed":
		return w.Area == q.Area && content.QuestIndex("lantern-road", s.State.Quests["lantern-road"]) >= content.QuestIndex(defaultStage(q.After)) && near(w, float64(q.TX*16+8), float64(q.TY*16+8)), nil
	case "quest", "gift":
		return q.From != "" && w.Area == q.Area && content.QuestIndex("lantern-road", s.State.Quests["lantern-road"]) >= content.QuestIndex(q.Stage), nil
	case "village-project":
		var due bool
		// A finished project in this world holds the paper, and this player helped build it
		// (the same rule as the projects read's grantablePapers).
		err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM project_papers p WHERE p.world_id=? AND p.paper_id=? AND EXISTS(SELECT 1 FROM contributions c WHERE c.world_id=p.world_id AND c.project_def=p.project_def AND c.account_id=?))", s.WorldID, in.Paper, s.AccountID).Scan(&due)
		return due, err
	case "commons":
		if w.Area != "commons" {
			return false, nil
		}
		var due bool
		var query string
		switch q.Fact {
		case "silas-toolbox":
			return true, nil
		case "carting-day":
			now := time.Now()
			if r.Now != nil {
				now = r.Now()
			}
			return content.CalendarAt(content.CalendarRules, now.Unix()).Festival != nil && *content.CalendarAt(content.CalendarRules, now.Unix()).Festival == "Carting Day", nil
		case "plot":
			query = "SELECT EXISTS(SELECT 1 FROM homestead_members WHERE account_id=?)"
		case "foundation":
			query = "SELECT EXISTS(SELECT 1 FROM homestead_members m JOIN homesteads h ON h.id=m.homestead_id WHERE m.account_id=? AND h.tier>=1)"
		case "door-fox":
			query = "SELECT EXISTS(SELECT 1 FROM homestead_members m JOIN homestead_items i USING(homestead_id) WHERE m.account_id=? AND i.item_def='door-fox' AND i.location='placed')"
		default:
			return false, nil
		}
		err := tx.QueryRowContext(ctx, query, s.AccountID).Scan(&due)
		return due, err
	case "turning":
		if q.Fact == "board" {
			board, ok := content.StoryRules.Boards[w.Area]
			return ok && near(w, float64(board.TX*16+8), float64(board.TY*16+8)), nil
		}
		if q.Fact == "turning" {
			return false, nil
		}
	}
	if q.Site == "" && in.Entity == "" && q.Member == "" {
		return false, nil
	}
	region, ok := strings.CutPrefix(w.Area, "wilds:")
	if !ok || r.Epochs == nil || r.Chunks == nil {
		return false, nil
	}
	now := time.Now()
	if r.Now != nil {
		now = r.Now()
	}
	epoch, err := r.Epochs.Current(ctx, tx, s.WorldID, region, now.Unix())
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, chunks.ErrEpochEnded) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if epoch.Id != in.Epoch {
		return false, nil
	}
	var def *content.WildsRegion
	for _, reg := range content.WildsRules.Regions {
		if reg.GetId() == region {
			def = reg
		}
	}
	if p.Source == "echo" {
		sites := []ports.EchoSite{}
		for cy := 0; cy < int(def.GetGridHeight()); cy++ {
			for cx := 0; cx < int(def.GetGridWidth()); cx++ {
				m, e := r.Chunks.Chunk(ctx, tx, s.WorldID, epoch.Id, 0, int32(cx), int32(cy))
				if e != nil {
					return false, e
				}
				for _, site := range m.Sites {
					sites = append(sites, ports.EchoSite{Site: site, CX: m.Cx, CY: m.Cy})
				}
			}
		}
		assignments, e := r.Echoes(ctx, tx, s, ports.EchoInput{Epoch: epoch, Sites: sites})
		if e != nil {
			return false, e
		}
		for _, a := range assignments {
			if a.Site == in.Site && a.Member == q.Member && a.Settled {
				for _, site := range sites {
					if site.Site.Id == in.Site {
						return near(w, float64((int(site.CX)*int(content.WildsRules.GetChunkSize())+int(site.Site.Tx))*16+8), float64((int(site.CY)*int(content.WildsRules.GetChunkSize())+int(site.Site.Ty))*16+8)), nil
					}
				}
			}
		}
		return false, nil
	}
	// Read geometry throughout the region, including sites across a chunk boundary.
	for cy := 0; cy < int(def.GetGridHeight()); cy++ {
		for cx := 0; cx < int(def.GetGridWidth()); cx++ {
			if q.East && cx != int(def.GetGridWidth())-1 {
				continue
			}
			chunk, err := r.Chunks.Chunk(ctx, tx, s.WorldID, in.Epoch, 0, int32(cx), int32(cy))
			if err != nil {
				return false, err
			}
			if q.Mark != "" && q.Mark != chunk.Mark {
				continue
			}
			for _, site := range chunk.Sites {
				kind := strings.ToLower(strings.TrimPrefix(site.Kind.String(), "SITE_KIND_"))
				if site.Id == in.Site && kind == q.Site && near(w, float64((cx*int(chunk.Size)+int(site.Tx))*16+8), float64((cy*int(chunk.Size)+int(site.Ty))*16+8)) {
					return true, nil
				}
			}
			for _, entity := range chunk.Entities {
				if entity.Id != in.Entity || q.POI != "" && (entity.Kind != "poi" || entity.Poi != q.POI) || q.Tier != 0 && (entity.Kind != "chest" || int(entity.Tier) != q.Tier) {
					continue
				}
				if q.POI == "" && q.Tier == 0 {
					continue
				}
				var claimed bool
				err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM personal_claims WHERE epoch=? AND entity_id=? AND account_id=?)", in.Epoch, in.Entity, s.AccountID).Scan(&claimed)
				return claimed, err
			}
		}
	}
	return false, nil
}
func defaultStage(s string) string {
	if s == "" {
		return "new"
	}
	return s
}

// Record observes a turning only through player placement, never a region read.
func (r Rules) Record(ctx context.Context, tx *sql.Tx, s *store.Snapshot, w *contract.Where, now int64) error {
	if w.Area != "wilds:outer-1" || r.Epochs == nil {
		return nil
	}
	epoch, err := r.Epochs.Current(ctx, tx, s.WorldID, "outer-1", now)
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, chunks.ErrEpochEnded) || errors.Is(err, chunks.ErrUnavailable) || errors.Is(err, store.ErrGeneratorUnavailable) {
		return nil
	}
	if err != nil {
		return err
	}
	var previous string
	var starts sql.NullFloat64
	if err = tx.QueryRowContext(ctx, "SELECT last_outer_epoch,last_outer_starts_at FROM player_place WHERE account_id=?", s.AccountID).Scan(&previous, &starts); err != nil {
		return err
	}
	if previous != "" && starts.Valid && epoch.StartsAt <= starts.Float64 {
		return nil
	}
	if previous != "" && starts.Valid && epoch.StartsAt > starts.Float64 {
		Mark(s, "wilds:turned")
		if !RoadLit(*s) {
			_, err = tx.ExecContext(ctx, "UPDATE player_place SET last_outer_epoch=?,last_outer_starts_at=? WHERE account_id=?", epoch.Id, epoch.StartsAt, s.AccountID)
			return err
		}
		if _, err = r.Grant(ctx, tx, s, "weir-effect-survey-draft", now); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, "UPDATE player_place SET last_outer_epoch=?,last_outer_starts_at=? WHERE account_id=?", epoch.Id, epoch.StartsAt, s.AccountID)
	return err
}
