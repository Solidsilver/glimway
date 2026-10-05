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
// HomeRect is a rectangle in local grid tiles (reserved scenery inside a plot or room).
type HomeRect struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

// CommonsLayout places plots on the Commons map in the client's tiles. Plot i
// sits in column i%len(Columns) and row i/len(Columns); listed rows give the
// designed rows' top tiles, and later rows continue down the lane at RowPitch.
type CommonsLayout struct {
	TileSize int   `json:"tileSize"`
	Columns  []int `json:"columns"`
	Rows     []int `json:"rows"`
	RowPitch int   `json:"rowPitch"`
}

type Homestead struct {
	Tiers   []HomeTier    `json:"tiers"`
	Outdoor HomeGrid      `json:"outdoor"`
	Indoor  HomeGrid      `json:"indoor"`
	Commons CommonsLayout `json:"commons"`
	// Reserved tiles hold the camp or cottage (outdoor) and the doorway (indoor):
	// decorations may not cover them.
	OutdoorReserved []HomeRect `json:"outdoorReserved"`
	IndoorReserved  []HomeRect `json:"indoorReserved"`
	Items           []HomeItem `json:"items"`
}

// PlotTile is plot i's top-left tile on the Commons map.
func (h Homestead) PlotTile(index int) (int, int) {
	c := h.Commons
	col, row := index%len(c.Columns), index/len(c.Columns)
	y := c.Rows[len(c.Rows)-1] + (row-len(c.Rows)+1)*c.RowPitch
	if row < len(c.Rows) {
		y = c.Rows[row]
	}
	return c.Columns[col], y
}

func validLayout(h Homestead) bool {
	c := h.Commons
	if c.TileSize <= 0 || len(c.Columns) == 0 || len(c.Rows) == 0 || c.RowPitch < h.Outdoor.Height {
		return false
	}
	for i, x := range c.Columns {
		if x < 0 || (i > 0 && x < c.Columns[i-1]+h.Outdoor.Width) {
			return false
		}
	}
	for i, y := range c.Rows {
		if y < 0 || (i > 0 && y < c.Rows[i-1]+h.Outdoor.Height) {
			return false
		}
	}
	return true
}

func validReserved(rects []HomeRect, g HomeGrid) bool {
	for _, r := range rects {
		if r.X < 0 || r.Y < 0 || r.W <= 0 || r.H <= 0 || r.X+r.W > g.Width || r.Y+r.H > g.Height {
			return false
		}
	}
	return true
}

func ValidateHomestead(h Homestead) error {
	bad := fmt.Errorf("invalid homestead")
	if len(h.Tiers) != 5 || h.Outdoor.Width != 16 || h.Outdoor.Height != 12 || h.Indoor.Width != 12 || h.Indoor.Height != 10 || !validLayout(h) || !validReserved(h.OutdoorReserved, h.Outdoor) || !validReserved(h.IndoorReserved, h.Indoor) || len(h.Items) == 0 {
		return bad
	}
	for i, t := range h.Tiers {
		if t.Tier != i || t.ID != fmt.Sprintf("tier-%d", i) || t.Name == "" || t.Purchasable != (i == 1 || i == 2) || ((i == 1 || i == 2) && t.Embers <= 0) || ((i == 0 || i > 2) && t.Embers != 0) || (i == 2 && !ValidMaterialCosts(t.Materials)) || (i != 2 && len(t.Materials) != 0) {
			return bad
		}
	}
	seen := map[string]bool{}
	for _, v := range h.Items {
		if v.ID == "" || v.Name == "" || seen[v.ID] || !slices.Contains([]string{"furniture", "decor", "utility"}, v.Category) || v.MinTier < 0 || v.MinTier > 4 || len(v.Footprint) != 2 || v.Footprint[0] <= 0 || v.Footprint[1] <= 0 || v.Footprint[0] > 12 || v.Footprint[1] > 10 || len(v.Where) == 0 || len(v.Where) > 2 || len(v.Materials) > 2 || (v.Embers > 0) == (len(v.Materials) > 0) || v.Embers < 0 {
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
