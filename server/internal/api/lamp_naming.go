package api

// The Keeper's hand and naming from parts (roadmap 0.13; lamps.md 1.3, 2.8).
//
// Mara's keepers-hand quest is driven by two server-written marks
// (content/story.json's keeper: namespace): keeper:cut, copying the cut
// from the quest's stone, the first Lantern Road stone past the Whitequiet;
// and keeper:lamp, seeing to a communal lamp once you hold keeper:hand
// (relighting, setting, tending, reading or naming one). The latecomer
// whose stone someone else lit tends or reads it instead; there is no race.
//
// A naming is parts only, never free text (content homestead.json
// lampNaming): ordinal, relation, a landmark the server finds near the lamp
// (or a fallback: the road, the Whitequiet), what is behind and ahead, and
// a closing. The server renders the sentence and short name from them and
// keeps the parts, the landmark and the words on the lamp's stable id
// (lamp_namings). A lamp is named once: its naming outlives the light, a
// crate and a reinstall, and the lamp ash it gives comes with that one
// naming, never with tending or lighting again. A portable lamp's naming
// (a communal post's or a camp's: a way-lamp piece) follows the piece into
// any world, so it is named once ever; a road stone's id repeats between
// worlds, so its naming is its world's.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strings"
	"sync"

	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
)

// The quest, and the marks its steps wait on.
const (
	keepersHand = "keepers-hand"
	keeperHand  = "keeper:hand" // granted by the quest's check-ledger step
	keeperCut   = "keeper:cut"  // the cut copied from the quest's stone
	keeperLamp  = "keeper:lamp" // a Keeper saw to a communal lamp
)

// namingLandmarks is how many found landmarks a lamp offers, nearest first,
// before the fallbacks.
const namingLandmarks = 6

// cutStones caches each world seed's quest stone (the road is long to lay).
var cutStones sync.Map

// cutStoneFor is the quest's stone for a world of this seed: the first lamp
// stone along the Lantern Road, out from the Whitequiet, that stands on
// visitable land inside the world border. Never a weekly site: the road and its
// stones are the seed's alone. Tests swap it (the fake generator lays no
// road).
var cutStoneFor = func(world, seed string) string {
	if v, ok := cutStones.Load(seed); ok {
		return v.(string)
	}
	id := ""
	for _, st := range wilds.RoadStones(seed) {
		if visitable(world, st.CX, st.CY) {
			id = st.ID
			break
		}
	}
	cutStones.Store(seed, id)
	return id
}

// cutStone is the world's quest stone.
func (a *Server) cutStone(ctx context.Context, tx *sql.Tx, world string, now int64) (string, error) {
	if a.Config.Epochs == nil {
		return "", store.ErrGeneratorUnavailable
	}
	e, err := chunks.Epoch(ctx, tx, a.Config.Epochs, world, store.EpochWick, now)
	if err != nil {
		return "", chunkError(err)
	}
	return cutStoneFor(world, e.WorldSeed), nil
}

// keeperSaw marks a Keeper's seeing to a communal lamp: the quest's last
// step waits on it. Anyone else's tending marks nothing.
func keeperSaw(s *store.Snapshot) {
	if questHasMark(s, keeperHand) {
		questMark(s, keeperLamp)
	}
}

// copyCut copies the cut from the quest's stone, lit or dark, from beside
// it, once Mara has asked for it.
func (a *Server) copyCut(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CommunalLampRequest, now int64) error {
	if content.QuestIndex(keepersHand, s.State.Quests[keepersHand]) < content.QuestIndex(keepersHand, "hear-mara") {
		return fail(409, "not-next-step")
	}
	stone, err := a.cutStone(ctx, tx, s.WorldID, now)
	if err != nil {
		return err
	}
	var cx, cy int
	if stone == "" || req.Lamp != stone {
		return fail(404, "no-lamp")
	}
	if _, err = fmt.Sscanf(stone, "lamp-stone:%d:%d", &cx, &cy); err != nil {
		return fail(404, "no-lamp")
	}
	land, err := a.wickChunk(ctx, tx, s.WorldID, cx, cy, now)
	if err != nil {
		return err
	}
	i := slices.IndexFunc(land.Chunk.Sites, func(v *contract.StorySite) bool {
		return v.Id == stone && v.Kind == contract.SiteKind_SITE_KIND_LAMP_STONE
	})
	if i < 0 {
		return fail(404, "no-lamp")
	}
	if !nearLamp(s, cx, cy, int(land.Chunk.Sites[i].Tx), int(land.Chunk.Sites[i].Ty)) {
		return fail(409, "too-far-away")
	}
	questMark(s, keeperCut)
	return nil
}

// readLamp reads a lit lamp's naming from beside it.
func readLamp(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CommunalLampRequest) (*communalLamp, error) {
	l, err := communalLampByID(ctx, tx, s.WorldID, req.Lamp)
	if err != nil {
		return nil, err
	}
	if l == nil {
		return nil, fail(404, "no-lamp")
	}
	if !nearLamp(s, l.CX, l.CY, l.X, l.Y) {
		return nil, fail(409, "too-far-away")
	}
	return l, nil
}

// nameCommunalLamp gives a lit communal lamp its naming: a Keeper's, from
// beside it.
func (a *Server) nameCommunalLamp(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CommunalLampRequest, now int64) (*communalLamp, []string, error) {
	l, err := communalLampByID(ctx, tx, s.WorldID, req.Lamp)
	if err != nil {
		return nil, nil, err
	}
	if l == nil {
		return nil, nil, fail(404, "no-lamp")
	}
	if !questHasMark(s, keeperHand) {
		return nil, nil, fail(409, "needs-keeper")
	}
	if !nearLamp(s, l.CX, l.CY, l.X, l.Y) {
		return nil, nil, fail(409, "too-far-away")
	}
	given, err := a.nameLamp(ctx, tx, s, l.ID, l.Kind == "post", l.CX, l.CY, l.X, l.Y, req.Parts, now)
	if err != nil {
		return nil, nil, err
	}
	return l, given, store.Visit(ctx, tx, s.WorldID, l.CX, l.CY, now)
}

// nameCamp gives a camp's way-lamp its naming: a Keeper who builds there,
// from beside it.
func (a *Server) nameCamp(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CampRequest, now int64) (*camp, []string, error) {
	c, err := campByID(ctx, tx, s.WorldID, req.Camp)
	if err != nil {
		return nil, nil, err
	}
	if c == nil {
		return nil, nil, fail(404, "no-camp")
	}
	if !questHasMark(s, keeperHand) {
		return nil, nil, fail(409, "needs-keeper")
	}
	if ok, err := campBuilder(ctx, tx, c, s.AccountID); err != nil || !ok {
		if err == nil {
			err = fail(409, "not-your-lamp")
		}
		return nil, nil, err
	}
	S := chunkSize()
	if !nearTile(s, outdoorsArea, c.CX*S+c.X, c.CY*S+c.Y, int(content.HomeRules.GetWayLamp().GetReach())) {
		return nil, nil, fail(409, "too-far-away")
	}
	given, err := a.nameLamp(ctx, tx, s, c.ID, true, c.CX, c.CY, c.X, c.Y, req.Parts, now)
	return c, given, err
}

// nameLamp writes a lamp's naming from its parts, once, and gives its ash.
// A portable lamp's naming has no world: it is the piece's, wherever it
// stands.
func (a *Server) nameLamp(ctx context.Context, tx *sql.Tx, s *store.Snapshot, id string, portable bool, cx, cy, x, y int, parts []string, now int64) ([]string, error) {
	var named bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM lamp_namings WHERE lamp_id=? AND (world_id=? OR world_id IS NULL))", id, s.WorldID).Scan(&named); err != nil {
		return nil, err
	}
	if named {
		return nil, fail(409, "lamp-named")
	}
	marks, err := a.lampLandmarks(ctx, tx, s.WorldID, id, cx, cy, x, y, now)
	if err != nil {
		return nil, err
	}
	n, ok := renderNaming(parts, marks)
	if !ok {
		return nil, fail(409, "invalid-naming")
	}
	raw, err := json.Marshal(parts)
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO lamp_namings(world_id,lamp_id,parts,landmark,text,short_name,namer,named_at) VALUES(?,?,?,?,?,?,?,?)", sql.NullString{String: s.WorldID, Valid: !portable}, id, string(raw), n.landmark, n.text, n.short, s.AccountID, now); err != nil {
		return nil, err
	}
	rules := content.HomeRules.GetLampNaming()
	if err = itemChange(ctx, tx, s, rules.GetAsh(), int(rules.GetAshQty()), "lamp-naming", id, now); err != nil {
		return nil, err
	}
	keeperSaw(s)
	return []string{rules.GetAsh()}, nil
}

// naming is a naming rendered from its parts.
type naming struct{ text, short, landmark string }

// words is a part's words from a list, or "".
func words(list []*content.NamingWord, id string) string {
	for _, w := range list {
		if w.GetId() == id {
			return w.GetWords()
		}
	}
	return ""
}

// renderNaming renders a naming from its six parts (ordinal, relation,
// landmark, behind, ahead, closing): false when any part isn't one on
// offer. Behind and ahead take a side phrase or an offered landmark.
func renderNaming(parts []string, marks []*contract.LampLandmark) (naming, bool) {
	if len(parts) != 6 {
		return naming{}, false
	}
	rules := content.HomeRules.GetLampNaming()
	landmark := func(id string) string {
		for _, m := range marks {
			if m.Id == id {
				return m.Phrase
			}
		}
		return ""
	}
	side := func(id string) string {
		if w := words(rules.GetSides(), id); w != "" {
			return w
		}
		return landmark(id)
	}
	ord, rel, mark := words(rules.GetOrdinals(), parts[0]), words(rules.GetRelations(), parts[1]), landmark(parts[2])
	behind, ahead, closing := side(parts[3]), side(parts[4]), words(rules.GetClosings(), parts[5])
	if ord == "" || rel == "" || mark == "" || behind == "" || ahead == "" || closing == "" {
		return naming{}, false
	}
	short := fmt.Sprintf("%s lamp %s %s", ord, rel, mark)
	return naming{
		text:     fmt.Sprintf("You are the %s lamp %s %s. Behind you %s; ahead %s. %s", ord, rel, mark, behind, ahead, closing),
		short:    strings.ToUpper(short[:1]) + short[1:],
		landmark: parts[2],
	}, true
}

// siteWord is a site kind as content names it ("lamp-stone").
func siteWord(k contract.SiteKind) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimPrefix(k.String(), "SITE_KIND_")), "_", "-")
}

// lampLandmarks are the landmarks a lamp may be named by: the places and
// sites content has words for in its chunk and the eight around it (as
// they stand this wick), nearest first and one of each phrase, then the
// fallbacks. The lamp itself is never its own landmark.
func (a *Server) lampLandmarks(ctx context.Context, tx *sql.Tx, world, self string, cx, cy, x, y int, now int64) ([]*contract.LampLandmark, error) {
	rules := content.HomeRules.GetLampNaming()
	S := chunkSize()
	ox, oy := cx*S+x, cy*S+y
	type found struct {
		mark *contract.LampLandmark
		d    int
	}
	var near []found
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			kx, ky := cx+dx, cy+dy
			if location.SourceOf(kx, ky).Kind != location.SourceGenerated || !location.OnGrid(kx, ky) {
				continue
			}
			land, err := a.wickChunk(ctx, tx, world, kx, ky, now)
			if err != nil {
				return nil, err
			}
			at := func(tx, ty uint32) int {
				ddx, ddy := kx*S+int(tx)-ox, ky*S+int(ty)-oy
				return ddx*ddx + ddy*ddy
			}
			for _, p := range land.Chunk.Places {
				if phrase := rules.GetPlaces()[p.Kind]; phrase != "" {
					near = append(near, found{&contract.LampLandmark{Id: p.Id, Phrase: phrase}, at(p.Tx, p.Ty)})
				}
			}
			for _, v := range land.Chunk.Sites {
				if phrase := rules.GetSites()[siteWord(v.Kind)]; phrase != "" && v.Id != self {
					near = append(near, found{&contract.LampLandmark{Id: "site:" + v.Id, Phrase: phrase}, at(v.Tx, v.Ty)})
				}
			}
		}
	}
	sort.SliceStable(near, func(i, j int) bool {
		if near[i].d != near[j].d {
			return near[i].d < near[j].d
		}
		return near[i].mark.Id < near[j].mark.Id
	})
	out := []*contract.LampLandmark{}
	phrases := map[string]bool{}
	for _, f := range near {
		if len(out) == namingLandmarks {
			break
		}
		if !phrases[f.mark.Phrase] {
			phrases[f.mark.Phrase] = true
			out = append(out, f.mark)
		}
	}
	for _, w := range rules.GetFallbacks() {
		out = append(out, &contract.LampLandmark{Id: w.GetId(), Phrase: w.GetWords()})
	}
	return out, nil
}

// lampLandmarksRead is GET /api/lamp-landmarks/<lamp>: the landmarks a
// naming of that lit communal lamp, or camp lamp, may use.
func (a *Server) lampLandmarksRead(w http.ResponseWriter, r *http.Request) error {
	id, err := url.PathUnescape(strings.TrimPrefix(r.URL.Path, "/api/lamp-landmarks/"))
	if err != nil || id == "" {
		return fail(404, "no-lamp")
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.requestTime(ctx).Unix()
	if err = a.turnWick(ctx, tx, s.WorldID, now); err != nil {
		return err
	}
	var cx, cy, x, y int
	if l, err := communalLampByID(ctx, tx, s.WorldID, id); err != nil {
		return err
	} else if l != nil {
		cx, cy, x, y = l.CX, l.CY, l.X, l.Y
	} else if c, err := campByID(ctx, tx, s.WorldID, id); err != nil {
		return err
	} else if c != nil {
		cx, cy, x, y = c.CX, c.CY, c.X, c.Y
	} else {
		return fail(404, "no-lamp")
	}
	marks, err := a.lampLandmarks(ctx, tx, s.WorldID, id, cx, cy, x, y, now)
	if err != nil {
		return err
	}
	return a.finishRead(w, r, tx, s, &contract.LampLandmarksRead{Landmarks: marks})
}
