package content

import (
	"encoding/json"
	"fmt"
	"maps"
	"slices"

	contentv1 "glimway/gen/glimway/content/v1"
	"google.golang.org/protobuf/proto"
)

// The homestead contract (content/homestead.json), on the generated types
// (proto/glimway/content/v1/homestead.proto): the tier ladder, the indoor
// room and wild land, the Commons lane's gates, and the home goods.
type (
	Homestead       = contentv1.Homestead
	HomeGrid        = contentv1.HomeGrid
	HomeTier        = contentv1.HomeTier
	HomeRect        = contentv1.HomeRect
	HomeLand        = contentv1.HomeLand
	HomeGate        = contentv1.HomeGate
	HomeStartLight  = contentv1.HomeStartLight
	HomePixelPos    = contentv1.HomePixelPos
	CommonsLane     = contentv1.CommonsLane
	LanternPosts    = contentv1.LanternPosts
	MaterialBill    = contentv1.MaterialBill
	HomeItem        = contentv1.HomeItem
	HomesteadStable = contentv1.HomesteadStable
)

// DecodeHomestead reads homestead JSON into the generated types, refusing
// nulls and unknown keys, fills each home good's name and footprint from
// the furnishings catalogue, then runs the schema's rules (protovalidate)
// and the homestead's own rules.
func DecodeHomestead(raw []byte) (*Homestead, error) {
	doc := &Homestead{}
	if err := decodeContentProto(raw, "homestead", doc); err != nil {
		return doc, err
	}
	if err := resolveHomeGoods(doc); err != nil {
		return doc, err
	}
	if err := contentValidate("homestead", entryLists(doc, "tiers", "items"), doc); err != nil {
		return doc, err
	}
	return doc, validateHomestead(doc)
}

// Outdoor is the land as a placement grid.
func Outdoor(h *Homestead) *HomeGrid {
	return homeGrid(h.GetLand().GetWidth(), h.GetLand().GetHeight())
}

func homeGrid(w, h int32) *HomeGrid {
	return &HomeGrid{Width: proto.Int32(w), Height: proto.Int32(h)}
}

// HomePostCost is what the n-th lantern post (0-based) of a homestead
// costs: the listed costs, then the last plus Growth for each one after.
// The bill is a copy: the shared table is never handed out.
func HomePostCost(h *Homestead, n int) map[string]int32 {
	c := h.GetLanternPosts().GetCosts()
	if n < len(c) {
		return maps.Clone(c[n].GetMaterials())
	}
	out := map[string]int32{}
	last := c[len(c)-1].GetMaterials()
	for m, v := range last {
		out[m] = v + h.GetLanternPosts().GetGrowth()[m]*int32(n-len(c)+1)
	}
	return out
}

// HomeStallCost is what the `extra`-th extra bay of a homestead's stable
// costs (extra is 1-based: the first bay after stall 1), grown by the
// stable's growth map per bay before it. The bill is a copy: the shared
// table is never handed out.
func HomeStallCost(h *Homestead, extra int) map[string]int32 {
	base := h.GetStable().GetStallCost()
	if extra < 1 {
		extra = 1
	}
	out := map[string]int32{}
	for m, v := range base {
		out[m] = v + h.GetStable().GetGrowth()[m]*int32(extra-1)
	}
	return out
}

func validReserved(rects []*HomeRect, g *HomeGrid) bool { //nolint:unparam
	for _, r := range rects {
		if r.GetX()+r.GetW() > g.GetWidth() || r.GetY()+r.GetH() > g.GetHeight() {
			return false
		}
	}
	return true
}

// validLane: the code rules of the Commons lane (the field rules are the
// schema's): gate rows go down the lane two tiles apart.
func validLane(c *CommonsLane) bool {
	rows := c.GetGateRows()
	for i, y := range rows {
		if i > 0 && y < rows[i-1]+2 {
			return false
		}
	}
	return true
}

// validPosts: the lantern posts' bills name Wilds materials (the ranges
// are the schema's), and growth never takes a material back.
func validPosts(p *LanternPosts) bool {
	for _, c := range p.GetCosts() {
		if !ValidMaterialCosts(c.GetMaterials()) {
			return false
		}
	}
	for m, n := range p.GetGrowth() {
		if !slices.Contains(WildsRules.Materials, m) || n < 0 {
			return false
		}
	}
	return true
}

// catalogueMaterials reads the catalogue's material ids straight from the
// file (not the validated rules, which would make an initialization cycle:
// the items loader checks its home goods against this file's homestead).
var catalogueMaterials = func() map[string]bool {
	var raw struct {
		Items []struct {
			ID   string `json:"id"`
			Kind string `json:"kind"`
		} `json:"items"`
	}
	out := map[string]bool{}
	if b, err := FS.ReadFile("items.json"); err == nil && json.Unmarshal(b, &raw) == nil {
		for _, v := range raw.Items {
			if v.Kind == "material" {
				out[v.ID] = true
			}
		}
	}
	return out
}()

// resolveHomeGoods fills each row's name and footprint from the furnishings
// catalogue; the homestead file keeps only the homestead-specific fields. A
// row that spells them out must match the catalogue, never disagree with it.
func resolveHomeGoods(h *Homestead) error {
	for _, v := range h.Items {
		f, ok := FurnishingFor(v.GetId())
		if !ok {
			return fmt.Errorf("invalid homestead: item %s not in the furnishings catalogue", v.GetId())
		}
		if v.GetName() != "" && v.GetName() != f.GetName() {
			return fmt.Errorf("invalid homestead: item %s names itself", v.GetId())
		}
		fp := v.GetFootprint()
		if len(fp) != 0 && (len(fp) != 2 || fp[0] != f.GetFootprint()[0] || fp[1] != f.GetFootprint()[1]) {
			return fmt.Errorf("invalid homestead: item %s footprint", v.GetId())
		}
		v.Name = f.GetName()
		v.Footprint = []int32{f.GetFootprint()[0], f.GetFootprint()[1]}
	}
	return nil
}

// validateHomestead: the rules that span entries or grids. The tier ladder
// is the designed five; reserved rectangles sit inside their grids; home
// good rows are unique, priced in Wilds or catalogue materials, and agree
// with the furnishing they name.
func validateHomestead(h *Homestead) error {
	tiers := h.GetTiers()
	for i, t := range tiers {
		if t.GetTier() != int32(i) || t.GetId() != fmt.Sprintf("tier-%d", i) || t.GetPurchasable() != (i == 1 || i == 2) || ((i == 1 || i == 2) && t.GetEmbers() <= 0) || ((i == 0 || i > 2) && t.GetEmbers() != 0) || (i == 2 && !ValidMaterialCosts(t.GetMaterials())) || (i != 2 && len(t.GetMaterials()) != 0) {
			return fmt.Errorf("invalid homestead: tier %d", i)
		}
	}
	if !validReserved(h.GetOutdoorReserved(), Outdoor(h)) || !validReserved(h.GetIndoorReserved(), h.GetIndoor()) {
		return fmt.Errorf("invalid homestead: reserved")
	}
	if !validLane(h.GetCommons()) {
		return fmt.Errorf("invalid homestead: gate rows")
	}
	if !validPosts(h.GetLanternPosts()) {
		return fmt.Errorf("invalid homestead: post bills")
	}
	seen := map[string]bool{}
	for _, v := range h.Items {
		if seen[v.GetId()] {
			return fmt.Errorf("invalid homestead: duplicate id %s", v.GetId())
		}
		seen[v.GetId()] = true
		for m, n := range v.GetMaterials() {
			// A purchase bill may name any carried material (seasoned
			// timber and their like), not only the Wilds four.
			if !slices.Contains(WildsRules.Materials, m) && !catalogueMaterials[m] {
				return fmt.Errorf("invalid homestead: item %s material %s", v.GetId(), m)
			}
			if n <= 0 {
				return fmt.Errorf("invalid homestead: item %s material %s", v.GetId(), m)
			}
		}
		// The row must agree with the furnishing it names: its name and
		// footprint are the catalogue's, never a second copy.
		f, ok := FurnishingFor(v.GetId())
		if !ok || v.GetName() != f.GetName() || len(v.GetFootprint()) != 2 || v.GetFootprint()[0] != f.GetFootprint()[0] || v.GetFootprint()[1] != f.GetFootprint()[1] {
			return fmt.Errorf("invalid homestead: item %s disagrees with the catalogue", v.GetId())
		}
	}
	if !seen[h.GetLanternPosts().GetItem()] {
		return fmt.Errorf("invalid homestead: lantern post item %s", h.GetLanternPosts().GetItem())
	}
	// The stable grows from its own row: its piece is in the build list,
	// its first extra bay's bill names carried materials, and each bay
	// after that only adds to materials the bill already names.
	s := h.GetStable()
	if !seen[s.GetItem()] {
		return fmt.Errorf("invalid homestead: stable item %s", s.GetItem())
	}
	for m, n := range s.GetStallCost() {
		if (!slices.Contains(WildsRules.Materials, m) && !catalogueMaterials[m]) || n <= 0 {
			return fmt.Errorf("invalid homestead: stable stall cost %s", m)
		}
	}
	for m, n := range s.GetGrowth() {
		if _, ok := s.GetStallCost()[m]; !ok || n < 0 {
			return fmt.Errorf("invalid homestead: stable growth %s", m)
		}
	}
	return nil
}

func LoadHomestead() (*Homestead, error) {
	raw, err := FS.ReadFile("homestead.json")
	if err != nil {
		return nil, err
	}
	return DecodeHomestead(raw)
}

var HomeRules = func() *Homestead {
	h, err := LoadHomestead()
	if err != nil {
		panic(err)
	}
	return h
}()

func HomeItemFor(id string) (*HomeItem, bool) {
	for _, v := range HomeRules.Items {
		if v.GetId() == id {
			return v, true
		}
	}
	return nil, false
}
