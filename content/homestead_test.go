package content

import (
	"maps"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// decodeSpliced re-marshals a spliced homestead with protojson and decodes
// it the way the loader does (schema rules included). resolveHomeGoods runs
// on the shipped file's already-resolved rows, so a spliced row's name and
// footprint are the catalogue's own and pass the agreement checks.
func decodeSplicedHomestead(t *testing.T, h *Homestead) error {
	t.Helper()
	raw, err := protojson.Marshal(h)
	if err != nil {
		t.Fatal(err)
	}
	_, err = DecodeHomestead(raw)
	return err
}

func TestHomesteadContent(t *testing.T) {
	h, err := LoadHomestead()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"Campsite", "Cottage", "Workshop", "Garden", "Hall"}
	for i, tier := range h.GetTiers() {
		if tier.GetName() != want[i] {
			t.Fatal("tier identity")
		}
	}
	if h.GetTiers()[1].GetGlims() != 15 || len(h.GetItems()) != 32 {
		t.Fatal("starting content")
	}
	for _, v := range h.GetItems() {
		if v.GetId() == h.GetLanternPosts().GetItem() {
			continue
		}
		// The stable is a building, priced above the furniture range.
		if v.GetId() == h.GetStable().GetItem() {
			continue
		}
		if v.GetGlims() > 0 && (v.GetGlims() < 2 || v.GetGlims() > 6) {
			t.Fatal("glim price")
		}
		for _, n := range v.GetMaterials() {
			if n < 4 || n > 10 {
				t.Fatal("material price")
			}
		}
	}
}
func TestHomesteadRejectsMalformed(t *testing.T) {
	for name, mutate := range map[string]func(*Homestead){
		"grid": func(h *Homestead) { h.Indoor.Width = proto.Int32(0) }, "duplicate": func(h *Homestead) { h.Items[1].Id = h.Items[0].GetId() }, "price": func(h *Homestead) { h.Items[0].Glims = -1 }, "unpriced": func(h *Homestead) { h.Items[0].Glims = 0; h.Items[0].Materials = map[string]int32{} }, "unknown-material": func(h *Homestead) { h.Items[8].Materials = map[string]int32{"gold": 1} }, "zero-material": func(h *Homestead) { h.Items[8].Materials = map[string]int32{"stone": 0} }, "footprint": func(h *Homestead) { h.Items[0].Footprint = []int32{1, 1, 1} }, "location": func(h *Homestead) { h.Items[0].Where = []string{"attic"} }, "tier": func(h *Homestead) { h.Tiers[3].Purchasable = true }, "min-tier": func(h *Homestead) { h.Items[0].MinTier = 5 }, "category": func(h *Homestead) { h.Items[0].Category = "weapon" }, "layout": func(h *Homestead) { h.Commons.FenceX = nil }, "crowded-rows": func(h *Homestead) { h.Commons.GateRows = []int32{4, 5} }, "short-pitch": func(h *Homestead) { h.Commons.RowPitch = 1 }, "no-spares": func(h *Homestead) { h.Commons.SpareGates = 0 }, "reserved": func(h *Homestead) {
			h.OutdoorReserved = []*HomeRect{{X: proto.Int32(39), Y: proto.Int32(0), W: proto.Int32(2), H: proto.Int32(1)}}
		},
		"land-size": func(h *Homestead) { h.Land.Width = 4 }, "generator": func(h *Homestead) { h.Land.Generator = 2 }, "gate": func(h *Homestead) { h.Land.Gate.X = proto.Int32(39) }, "permille": func(h *Homestead) { h.Land.StreamPermille = 1001 },
		"post-item": func(h *Homestead) { h.LanternPosts.Item = "nope" }, "post-cost": func(h *Homestead) { h.LanternPosts.Costs = nil }, "post-material": func(h *Homestead) { h.LanternPosts.Growth = map[string]int32{"gold": 1} },
		"stable-item": func(h *Homestead) { h.Stable.Item = "nope" }, "stable-cost": func(h *Homestead) { h.Stable.StallCost = nil }, "stable-growth": func(h *Homestead) { h.Stable.Growth = map[string]int32{"amber": 1} }, "stable-free": func(h *Homestead) { h.Stable.StallCost = map[string]int32{"timber": 0} },
		"deed": func(h *Homestead) { h.Deeds.Glims = 0 }, "desolation": func(h *Homestead) { h.Desolation.DeedLostAfterDays = h.Desolation.DesolateAfterDays }, "window": func(h *Homestead) { h.JointDeed.ConfirmWindowSeconds = 0 }, "chest": func(h *Homestead) { h.PersonalChest.MaxUnits = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			h := proto.Clone(HomeRules).(*Homestead)
			mutate(h)
			if err := decodeSplicedHomestead(t, h); err == nil {
				t.Fatal("accepted invalid content")
			}
		})
	}
}

func TestPostCostGrows(t *testing.T) {
	h := HomeRules
	prev := 0
	for n := 0; n < 6; n++ {
		total := 0
		for _, v := range HomePostCost(h, n) {
			total += int(v)
		}
		if total <= prev {
			t.Fatalf("post %d costs %d, not more than %d", n, total, prev)
		}
		prev = total
	}
}

func TestHomesteadLoaderVectors(t *testing.T) {
	runLoaderVectors(t, "homestead", "homestead-loader", func(raw []byte) (any, error) { return DecodeHomestead(raw) })
}

// The shared stall-cost bill (content/vectors/homestead-loader.json) is the
// one the TypeScript loader computes too: each extra bay's bill, grown from
// the stable's section.
func TestStallCostVectors(t *testing.T) {
	var vectors struct {
		StallCost []struct {
			Extra int              `json:"extra"`
			Bill  map[string]int32 `json:"bill"`
		} `json:"stallCost"`
	}
	readVectors(t, "homestead-loader", &vectors)
	if len(vectors.StallCost) == 0 {
		t.Fatal("no stall cost vectors")
	}
	for _, v := range vectors.StallCost {
		if bill := HomeStallCost(HomeRules, v.Extra); !maps.Equal(bill, v.Bill) {
			t.Fatalf("extra %d: %v, want %v", v.Extra, bill, v.Bill)
		}
	}
}
