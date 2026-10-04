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
	Tier        int    `json:"tier"`
	ID          string `json:"id"`
	Name        string `json:"name"`
	Purchasable bool   `json:"purchasable"`
	Embers      int    `json:"embers"`
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
type Homestead struct {
	Tiers   []HomeTier `json:"tiers"`
	Outdoor HomeGrid   `json:"outdoor"`
	Indoor  HomeGrid   `json:"indoor"`
	Commons struct {
		TileSize int `json:"tileSize"`
		Columns  int `json:"columns"`
		Gap      int `json:"gap"`
		OriginX  int `json:"originX"`
		OriginY  int `json:"originY"`
	} `json:"commons"`
	Items []HomeItem `json:"items"`
}

func ValidateHomestead(h Homestead) error {
	bad := fmt.Errorf("invalid homestead")
	if len(h.Tiers) != 5 || h.Outdoor.Width != 16 || h.Outdoor.Height != 12 || h.Indoor.Width != 12 || h.Indoor.Height != 10 || h.Commons.TileSize <= 0 || h.Commons.Columns <= 0 || h.Commons.Gap < 0 || h.Commons.OriginX < 0 || h.Commons.OriginY < 0 || len(h.Items) == 0 {
		return bad
	}
	for i, t := range h.Tiers {
		if t.Tier != i || t.ID != fmt.Sprintf("tier-%d", i) || t.Name == "" || t.Purchasable != (i == 1) || (i == 1 && t.Embers <= 0) || (i != 1 && t.Embers != 0) {
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
