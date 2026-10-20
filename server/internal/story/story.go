// Package story owns quest, mark, paper and Echo rules. Grants share the operation transaction.
package story

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/frontier"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/ports"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"google.golang.org/protobuf/proto"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// EchoFootprint is the footprint whose dealt sites the Echoes wait at.
const EchoFootprint = "whitequiet"

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
	// The Echoes wait in the Whitequiet (decision 11): its east column is
	// the footprint's last.
	east := int32(-1)
	if p := wilds.Footprint(EchoFootprint); p != nil {
		east = p.GetCx() + p.GetWidth() - 1
	}
	used := map[string]bool{}
	for _, site := range sites {
		if site.Site.Kind != contract.SiteKind_SITE_KIND_ECHO {
			continue
		}
		eligible := []*content.Echo{}
		for _, e := range content.StoryRules.Echoes {
			if !used[e.GetMember()] && (!e.GetLate() || RoadLit(s)) && (!e.GetEast() || site.CX == east) {
				eligible = append(eligible, e)
			}
		}
		if len(eligible) == 0 {
			continue
		}
		pick := eligible[uint32(wilds.Hash(in.Epoch.WorldSeed, EchoFootprint, in.Epoch.Season, "echo", site.Site.Id))%uint32(len(eligible))]
		used[pick.GetMember()] = true
		out = append(out, &contract.EchoAssignment{Site: site.Site.Id, Member: pick.GetMember(), Settled: slices.Contains(s.State.Flags, "echo:"+pick.Member)})
	}
	return out, nil
}
func near(w *contract.Where, x, y float64) bool { dx, dy := w.X-x, w.Y-y; return dx*dx+dy*dy <= 32*32 }
func (r Rules) Eligible(ctx context.Context, tx *sql.Tx, s store.Snapshot, in ports.PaperInput) (bool, error) {
	p, ok := content.PapersByID[in.Paper]
	if !ok || p.GetRule().GetUnbuilt() || in.Where == nil {
		return false, nil
	}
	q := p.GetRule()
	w := in.Where
	if q.GetRoadLit() && !RoadLit(s) || q.GetPaper() != "" && !slices.Contains(s.State.Flags, "paper:"+q.GetPaper()) {
		return false, nil
	}
	if q.GetFact() == "turned" || q.GetFact() == "board" {
		if !slices.Contains(s.State.Flags, "wilds:turned") {
			return false, nil
		}
	}
	switch p.Source {
	case "placed":
		return location.At(location.Space(w.Area), w.X, w.Y).ID == q.GetArea() && content.QuestIndex("lantern-road", s.State.Quests["lantern-road"]) >= content.QuestIndex(defaultStage(q.GetAfter())) && nearContent(w, q.GetArea(), int(q.GetTx()), int(q.GetTy())), nil
	case "quest", "gift":
		return q.GetFrom() != "" && location.At(location.Space(w.Area), w.X, w.Y).ID == q.GetArea() && content.QuestIndex("lantern-road", s.State.Quests["lantern-road"]) >= content.QuestIndex(q.GetStage()), nil
	case "village-project":
		var due bool
		// A finished project in this world holds the paper, and this player helped build it
		// (the same rule as the projects read's grantablePapers).
		err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM project_papers p WHERE p.world_id=? AND p.paper_id=? AND EXISTS(SELECT 1 FROM contributions c WHERE c.world_id=p.world_id AND c.project_def=p.project_def AND c.account_id=?))", s.WorldID, in.Paper, s.AccountID).Scan(&due)
		return due, err
	case "commons":
		// Town and its rooms share eligibility (the deed is bought in Pell's office).
		if location.At(location.Space(w.Area), w.X, w.Y).ID != "hearthwick" && content.RootArea(w.Area) != "hearthwick" {
			return false, nil
		}
		var due bool
		var query string
		switch q.GetFact() {
		case "silas-toolbox":
			return true, nil
		case "carting-day":
			now := r.readTime(ctx)
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
		if q.GetFact() == "board" {
			board, ok := content.StoryRules.GetBoards()[location.At(location.Space(w.Area), w.X, w.Y).ID]
			return ok && nearContent(w, location.At(location.Space(w.Area), w.X, w.Y).ID, int(board.GetTx()), int(board.GetTy())), nil
		}
		if q.GetFact() == "turning" {
			return false, nil
		}
	}
	if q.GetSite() == "" && in.Entity == "" && q.GetMember() == "" {
		return false, nil
	}
	if w.Area != string(location.Outdoors) || location.At(location.Space(w.Area), w.X, w.Y).Source.Kind != location.SourceGenerated || r.Epochs == nil || r.Chunks == nil {
		return false, nil
	}
	now := r.readTime(ctx)
	// The operation names its epoch: it must be one of the world's current
	// ones (the Tangle's still epoch or this wick's).
	var epoch *contract.WildsEpoch
	for _, kind := range []string{"still", "wick"} {
		e, err := r.Epochs.Current(ctx, tx, s.WorldID, kind, now.Unix())
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, chunks.ErrEpochEnded) {
			continue
		}
		if err != nil {
			return false, err
		}
		if e.Id == in.Epoch {
			epoch = e
		}
	}
	// A claim in a held chunk names the wick epoch its chunk is pinned to
	// (holds): good for the claimed entity's facts only, since sites and
	// Echoes are footprints', which are never held.
	held := false
	if cx, cy, ok := EntityChunk(s.WorldID, in.Entity); epoch == nil && ok {
		e, err := store.HeldEpoch(ctx, tx, s.WorldID, cx, cy)
		if err != nil {
			return false, err
		}
		if e != nil && e.Id == in.Epoch {
			epoch, held = e, true
		}
	}
	if epoch == nil {
		return false, nil
	}
	S := int(content.WildsRules.GetChunkSize())
	nearTile := func(cx, cy int32, tx, ty uint32) bool {
		return near(w, float64((int(cx)*S+int(tx))*16+8), float64((int(cy)*S+int(ty))*16+8))
	}
	if p.Source == "echo" {
		if epoch.Kind != "wick" || held {
			return false, nil
		}
		sites, e := FootprintSites(ctx, tx, r.Chunks, s.WorldID, epoch, EchoFootprint)
		if e != nil {
			return false, e
		}
		assignments, e := r.Echoes(ctx, tx, s, ports.EchoInput{Epoch: epoch, Sites: sites})
		if e != nil {
			return false, e
		}
		for _, a := range assignments {
			if a.Site == in.Site && a.Member == q.Member && a.Settled {
				for _, site := range sites {
					if site.Site.Id == in.Site {
						return nearTile(site.CX, site.CY, site.Site.Tx, site.Site.Ty), nil
					}
				}
			}
		}
		return false, nil
	}
	// east: the chunk is in its footprint's east column.
	east := func(cx, cy int) bool {
		f := wilds.FootprintAt(cx, cy)
		return f != nil && cx == int(f.GetCx()+f.GetWidth())-1
	}
	if in.Site != "" && q.GetSite() != "" {
		if held {
			return false, nil
		}
		// Sites are the footprints' (the papers' sites never leave them).
		for _, f := range content.WildsRules.Places {
			if f.GetEpochKind() != epoch.Kind {
				continue
			}
			for cy := f.GetCy(); cy < f.GetCy()+f.GetHeight(); cy++ {
				for cx := f.GetCx(); cx < f.GetCx()+f.GetWidth(); cx++ {
					if q.East && !east(int(cx), int(cy)) {
						continue
					}
					chunk, err := r.Chunks.Chunk(ctx, tx, s.WorldID, epoch.Id, 0, cx, cy)
					if err != nil {
						return false, err
					}
					if q.Mark != "" && q.Mark != chunk.Mark {
						continue
					}
					for _, site := range chunk.Sites {
						kind := strings.ReplaceAll(strings.ToLower(strings.TrimPrefix(site.Kind.String(), "SITE_KIND_")), "_", "-")
						if site.Id == in.Site && kind == q.Site && nearTile(cx, cy, site.Tx, site.Ty) {
							return true, nil
						}
					}
				}
			}
		}
		return false, nil
	}
	if in.Entity == "" || q.GetPoi() == "" && q.Tier == 0 {
		return false, nil
	}
	cx, cy, ok := EntityChunk(s.WorldID, in.Entity)
	if !ok || wilds.EpochKindAt(cx, cy) != epoch.Kind || q.East && !east(cx, cy) {
		return false, nil
	}
	chunk, err := r.Chunks.Chunk(ctx, tx, s.WorldID, epoch.Id, 0, int32(cx), int32(cy))
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if q.Mark != "" && q.Mark != chunk.Mark {
		return false, nil
	}
	for _, entity := range chunk.Entities {
		if entity.Id != in.Entity || q.GetPoi() != "" && (entity.Kind != "poi" || entity.Poi != q.GetPoi()) || q.Tier != 0 && (entity.Kind != "chest" || int(entity.Tier) != int(q.GetTier())) {
			continue
		}
		var claimed bool
		err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM personal_claims WHERE epoch=? AND entity_id=? AND account_id=?)", in.Epoch, in.Entity, s.AccountID).Scan(&claimed)
		return claimed, err
	}
	return false, nil
}

// EntityChunk is the chunk an entity id names ("<kind>:<cx>:<cy>:<i>",
// signed), inside the world's frontier.
func EntityChunk(world, id string) (cx, cy int, ok bool) {
	parts := strings.Split(id, ":")
	if len(parts) != 4 || len(id) > 128 {
		return 0, 0, false
	}
	x, e1 := strconv.Atoi(parts[1])
	y, e2 := strconv.Atoi(parts[2])
	if e1 != nil || e2 != nil || strconv.Itoa(x) != parts[1] || strconv.Itoa(y) != parts[2] || !frontier.Inside(world, x, y) {
		return 0, 0, false
	}
	return x, y, true
}

// FootprintSites reads a footprint's story sites in the epoch, from its
// stored chunks (row-major).
func FootprintSites(ctx context.Context, tx *sql.Tx, source chunks.ChunkSource, world string, epoch *contract.WildsEpoch, footprint string) ([]ports.EchoSite, error) {
	f := wilds.Footprint(footprint)
	if f == nil || f.GetEpochKind() != epoch.Kind {
		return nil, nil
	}
	out := []ports.EchoSite{}
	for cy := f.GetCy(); cy < f.GetCy()+f.GetHeight(); cy++ {
		for cx := f.GetCx(); cx < f.GetCx()+f.GetWidth(); cx++ {
			m, err := source.Chunk(ctx, tx, world, epoch.Id, 0, cx, cy)
			if err != nil {
				return nil, err
			}
			for _, site := range m.Sites {
				out = append(out, ports.EchoSite{Site: proto.Clone(site).(*contract.StorySite), CX: m.Cx, CY: m.Cy})
			}
		}
	}
	return out, nil
}
func defaultStage(s string) string {
	if s == "" {
		return "new"
	}
	return s
}

// Record observes a turning only through player placement, never a read:
// standing on land that turns at the wick (the Whitequiet and the Beyond)
// remembers this wick's epoch, and a newer one marks wilds:turned.
func (r Rules) Record(ctx context.Context, tx *sql.Tx, s *store.Snapshot, w *contract.Where, now int64) error {
	if w.Area != string(location.Outdoors) || r.Epochs == nil {
		return nil
	}
	tx0, ty0 := wilds.TileOfPixel(w.X, w.Y)
	if cx, cy := wilds.ChunkOf(tx0, ty0); location.SourceOf(cx, cy).Kind != location.SourceGenerated || location.SourceOf(cx, cy).EpochKind != "wick" {
		return nil
	}
	epoch, err := r.Epochs.Current(ctx, tx, s.WorldID, "wick", now)
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, chunks.ErrEpochEnded) || errors.Is(err, chunks.ErrUnavailable) || errors.Is(err, store.ErrGeneratorUnavailable) {
		return nil
	}
	if err != nil {
		return err
	}
	var previous string
	var starts sql.NullFloat64
	if err = tx.QueryRowContext(ctx, "SELECT last_wick_epoch,last_wick_starts_at FROM player_place WHERE account_id=?", s.AccountID).Scan(&previous, &starts); err != nil {
		return err
	}
	if previous != "" && starts.Valid && epoch.StartsAt <= starts.Float64 {
		return nil
	}
	if previous != "" && starts.Valid && epoch.StartsAt > starts.Float64 {
		Mark(s, "wilds:turned")
		if !RoadLit(*s) {
			_, err = tx.ExecContext(ctx, "UPDATE player_place SET last_wick_epoch=?,last_wick_starts_at=? WHERE account_id=?", epoch.Id, epoch.StartsAt, s.AccountID)
			return err
		}
		if _, err = r.Grant(ctx, tx, s, "weir-effect-survey-draft", now); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, "UPDATE player_place SET last_wick_epoch=?,last_wick_starts_at=? WHERE account_id=?", epoch.Id, epoch.StartsAt, s.AccountID)
	return err
}

func (r Rules) readTime(ctx context.Context) time.Time {
	if now, ok := chunks.ReadTime(ctx); ok {
		return now
	}
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Content positions already use world tiles. A place label maps to its
// saved space without translating the coordinates.
func nearContent(w *contract.Where, area string, tx, ty int) bool {
	space := location.ContentSpace(area)
	return w.Area == string(space) && near(w, float64(tx*16+8), float64(ty*16+8))
}
