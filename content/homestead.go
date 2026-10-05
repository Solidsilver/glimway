package content

import (
	"encoding/json"
	"fmt"
	"slices"
)

type HomeGrid struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}
type HomeTier struct {
	Tier        int            `json:"tier"`
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Purchasable bool           `json:"purchasable"`
	Embers      int            `json:"embers"`
	Materials   map[string]int `json:"materials,omitempty"`
}
type HomeItem struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Category  string         `json:"category"`
	Footprint []int          `json:"footprint"`
	Where     []string       `json:"where"`
	MinTier   int            `json:"minTier"`
	Embers    int            `json:"embers"`
	Materials map[string]int `json:"materials"`
}

// HomeRect is a rectangle in local grid tiles (reserved scenery on the land or in a room).
type HomeRect struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

// HomeLand describes every homestead's wild land: its size, the home site
// (camp/cottage), the gate mouth on the south edge, the starting light, and
// how much of the wild the generator scatters (server/internal/land).
type HomeLand struct {
	Generator int      `json:"generator"`
	Width     int      `json:"width"`
	Height    int      `json:"height"`
	Site      HomeRect `json:"site"`
	Gate      struct {
		X int `json:"x"`
		W int `json:"w"`
	} `json:"gate"`
	StartLight struct {
		X      int `json:"x"`
		Y      int `json:"y"`
		Radius int `json:"radius"`
	} `json:"startLight"`
	Trees          int `json:"trees"`
	Stumps         int `json:"stumps"`
	Boulders       int `json:"boulders"`
	StreamPermille int `json:"streamPermille"`
	SlopePermille  int `json:"slopePermille"`
}

// CommonsLane lays the homestead gates along the Commons lane (client tiles).
// Gate g is on side g%2 (fence column FenceX[side]) in row g/2: the listed
// rows, then one more every RowPitch tiles. SilasTable is where a joint deed
// is signed (pixels, with the reach both partners must be within).
type CommonsLane struct {
	TileSize   int   `json:"tileSize"`
	FenceX     []int `json:"fenceX"`
	GateRows   []int `json:"gateRows"`
	RowPitch   int   `json:"rowPitch"`
	SpareGates int   `json:"spareGates"`
	SilasTable struct {
		X      int `json:"x"`
		Y      int `json:"y"`
		Radius int `json:"radius"`
	} `json:"silasTable"`
}

// LanternPosts: the post item, its light radius, and what the n-th post costs
// (the listed costs, then the last plus Growth for each one after).
type LanternPosts struct {
	Item    string           `json:"item"`
	Radius  int              `json:"radius"`
	NameMax int              `json:"nameMax"`
	Costs   []map[string]int `json:"costs"`
	Growth  map[string]int   `json:"growth"`
}

type Homestead struct {
	Tiers  []HomeTier  `json:"tiers"`
	Indoor HomeGrid    `json:"indoor"`
	Land   HomeLand    `json:"land"`
	Lane   CommonsLane `json:"commons"`
	// Reserved land tiles (the home site and the gate mouth) and the indoor
	// doorway: decorations may not cover them.
	OutdoorReserved []HomeRect   `json:"outdoorReserved"`
	IndoorReserved  []HomeRect   `json:"indoorReserved"`
	LanternPosts    LanternPosts `json:"lanternPosts"`
	Deeds           struct {
		FirstFree bool `json:"firstFree"`
		Embers    int  `json:"embers"`
	} `json:"deeds"`
	ClearTileEmbers int `json:"clearTileEmbers"`
	Desolation      struct {
		DesolateAfterDays int `json:"desolateAfterDays"`
		DeedLostAfterDays int `json:"deedLostAfterDays"`
	} `json:"desolation"`
	JointDeed struct {
		ConfirmWindowSeconds int `json:"confirmWindowSeconds"`
		InviteHours          int `json:"inviteHours"`
	} `json:"jointDeed"`
	PersonalChest struct {
		MaxUnits int `json:"maxUnits"`
	} `json:"personalChest"`
	Items []HomeItem `json:"items"`
}

// Outdoor is the land as a placement grid.
func (h Homestead) Outdoor() HomeGrid { return HomeGrid{h.Land.Width, h.Land.Height} }

// PostCost is what the n-th lantern post (0-based) of a homestead costs.
func (h Homestead) PostCost(n int) map[string]int {
	c := h.LanternPosts.Costs
	if n < len(c) {
		return c[n]
	}
	out := map[string]int{}
	for m, v := range c[len(c)-1] {
		out[m] = v + h.LanternPosts.Growth[m]*(n-len(c)+1)
	}
	return out
}

func validReserved(rects []HomeRect, g HomeGrid) bool {
	for _, r := range rects {
		if r.X < 0 || r.Y < 0 || r.W <= 0 || r.H <= 0 || r.X+r.W > g.Width || r.Y+r.H > g.Height {
			return false
		}
	}
	return true
}

func validLand(l HomeLand) bool {
	g := HomeGrid{l.Width, l.Height}
	return l.Generator == 1 && l.Width >= 20 && l.Width <= 120 && l.Height >= 16 && l.Height <= 120 &&
		validReserved([]HomeRect{l.Site}, g) && l.Gate.X > 0 && l.Gate.W > 0 && l.Gate.X+l.Gate.W < l.Width &&
		l.StartLight.Radius > 0 && l.StartLight.X > 0 && l.StartLight.Y > 0 && l.StartLight.X < l.Width && l.StartLight.Y < l.Height &&
		l.Trees >= 0 && l.Stumps >= 0 && l.Boulders >= 0 && l.StreamPermille >= 0 && l.StreamPermille <= 1000 && l.SlopePermille >= 0 && l.SlopePermille <= 1000
}

func validLane(c CommonsLane) bool {
	if c.TileSize <= 0 || len(c.FenceX) != 2 || len(c.GateRows) == 0 || c.RowPitch < 2 || c.SpareGates < 1 || c.SilasTable.Radius <= 0 {
		return false
	}
	for i, y := range c.GateRows {
		if y < 0 || (i > 0 && y < c.GateRows[i-1]+2) {
			return false
		}
	}
	return c.FenceX[0] >= 0 && c.FenceX[1] > c.FenceX[0]
}

func validPosts(p LanternPosts) bool {
	if p.Item == "" || p.Radius <= 0 || p.NameMax < 1 || p.NameMax > 80 || len(p.Costs) == 0 {
		return false
	}
	for _, c := range p.Costs {
		if !ValidMaterialCosts(c) {
			return false
		}
	}
	for m, n := range p.Growth {
		if !slices.Contains(WildsRules.Materials, m) || n < 0 {
			return false
		}
	}
	return true
}

func ValidateHomestead(h Homestead) error {
	bad := fmt.Errorf("invalid homestead")
	if len(h.Tiers) != 5 || h.Indoor.Width != 12 || h.Indoor.Height != 10 || !validLand(h.Land) || !validLane(h.Lane) || !validReserved(h.OutdoorReserved, h.Outdoor()) || !validReserved(h.IndoorReserved, h.Indoor) || !validPosts(h.LanternPosts) || len(h.Items) == 0 {
		return bad
	}
	if h.Deeds.Embers <= 0 || h.ClearTileEmbers <= 0 || h.Desolation.DesolateAfterDays < 1 || h.Desolation.DeedLostAfterDays <= h.Desolation.DesolateAfterDays || h.JointDeed.ConfirmWindowSeconds < 5 || h.JointDeed.InviteHours < 1 || h.PersonalChest.MaxUnits < 1 {
		return bad
	}
	for i, t := range h.Tiers {
		if t.Tier != i || t.ID != fmt.Sprintf("tier-%d", i) || t.Name == "" || t.Purchasable != (i == 1 || i == 2) || ((i == 1 || i == 2) && t.Embers <= 0) || ((i == 0 || i > 2) && t.Embers != 0) || (i == 2 && !ValidMaterialCosts(t.Materials)) || (i != 2 && len(t.Materials) != 0) {
			return bad
		}
	}
	seen := map[string]bool{}
	for _, v := range h.Items {
		if v.ID == "" || v.Name == "" || seen[v.ID] || !slices.Contains([]string{"furniture", "decor", "utility"}, v.Category) || v.MinTier < 0 || v.MinTier > 4 || len(v.Footprint) != 2 || v.Footprint[0] <= 0 || v.Footprint[1] <= 0 || v.Footprint[0] > 12 || v.Footprint[1] > 10 || len(v.Where) == 0 || len(v.Where) > 2 || len(v.Materials) > 3 || (v.Embers > 0) == (len(v.Materials) > 0) || v.Embers < 0 {
			return bad
		}
		seen[v.ID] = true
		places := map[string]bool{}
		for _, p := range v.Where {
			if (p != "indoor" && p != "outdoor") || places[p] {
				return bad
			}
			places[p] = true
		}
		for m, n := range v.Materials {
			if !slices.Contains(WildsRules.Materials, m) || n <= 0 {
				return bad
			}
		}
	}
	if !seen[h.LanternPosts.Item] {
		return bad
	}
	return nil
}
func LoadHomestead() (Homestead, error) {
	var h Homestead
	b, err := FS.ReadFile("homestead.json")
	if err == nil {
		err = json.Unmarshal(b, &h)
	}
	if err == nil {
		err = ValidateHomestead(h)
	}
	return h, err
}

var HomeRules = func() Homestead {
	h, err := LoadHomestead()
	if err != nil {
		panic(err)
	}
	return h
}()

func HomeItemFor(id string) (HomeItem, bool) {
	for _, v := range HomeRules.Items {
		if v.ID == id {
			return v, true
		}
	}
	return HomeItem{}, false
}
