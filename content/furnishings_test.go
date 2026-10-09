package content

import (
	"encoding/json"
	"testing"
)

func TestFurnishingsLoaderVectors(t *testing.T) {
	var vectors struct {
		Loader     []loaderVector
		Pieces     map[string]json.RawMessage
		Placements []struct {
			Name  string
			Piece string
			Onto  struct {
				Kind  string `json:"kind"`
				Host  string `json:"host,omitempty"`
				Offer string `json:"offer,omitempty"`
			}
			At *int
			OK bool
		}
	}
	readVectors(t, "furnishings", &vectors)
	base, _ := FS.ReadFile("furnishings.json")
	for _, v := range vectors.Loader {
		t.Run("loader/"+v.Name, func(t *testing.T) {
			_, err := DecodeFurnishings(editVector(t, base, v))
			if (err == nil) != v.Valid {
				t.Fatal(v.Valid, err)
			}
			if !v.Valid && v.Rule != "" {
				checkVectorRule(t, err, v.Rule)
			}
		})
	}
	if len(vectors.Pieces) == 0 || len(vectors.Placements) == 0 {
		t.Fatal("no placement vectors")
	}
	// The placement vectors' pieces are hand-written JSON fixtures, decoded
	// with protojson: encoding/json into proto structs only works while the
	// struct tags happen to match.
	pieces := map[string]*Furnishing{}
	for id, raw := range vectors.Pieces {
		piece := &Furnishing{}
		decodeProto(t, raw, piece)
		pieces[id] = piece
	}
	for _, v := range vectors.Placements {
		t.Run("place/"+v.Name, func(t *testing.T) {
			piece, ok := pieces[v.Piece]
			if !ok {
				t.Fatal("unknown piece " + v.Piece)
			}
			onto := PlaceOn{Kind: v.Onto.Kind, Offer: v.Onto.Offer}
			if v.Onto.Host != "" {
				host, ok := pieces[v.Onto.Host]
				if !ok {
					t.Fatal("unknown host " + v.Onto.Host)
				}
				onto.Host = host
			}
			at := 0
			if v.At != nil {
				at = *v.At
			}
			if CanPlace(piece, onto, at) != v.OK {
				t.Fatal(v.Name)
			}
		})
	}
}

// Homestead rows only refer to the catalogue by id; the loader fills in
// each row's name and footprint and refuses unknown ids.
func TestHomesteadReadsItemsThroughTheCatalogue(t *testing.T) {
	h, err := LoadHomestead()
	if err != nil {
		t.Fatal(err)
	}
	stool, ok := FurnishingFor("wooden-stool")
	if !ok {
		t.Fatal("catalogue lost the wooden stool")
	}
	if h.Items[0].ID != "wooden-stool" || h.Items[0].Name != stool.GetName() || h.Items[0].Footprint[0] != int(stool.GetFootprint()[0]) || h.Items[0].Footprint[1] != int(stool.GetFootprint()[1]) {
		t.Fatal("home goods do not come from the catalogue")
	}
	for _, v := range h.Items {
		if _, ok := FurnishingFor(v.ID); !ok {
			t.Fatal("unresolved home good " + v.ID)
		}
	}
	var broken Homestead
	b, _ := json.Marshal(h)
	if err := json.Unmarshal(b, &broken); err != nil {
		t.Fatal(err)
	}
	broken.Items[0].ID = "no-such-piece"
	if err := resolveHomeGoods(&broken); err == nil {
		t.Fatal("accepted an unknown furnishing reference")
	}
	broken.Items[0].ID = h.Items[0].ID
	broken.Items[0].Name = "Wrong Name"
	if err := resolveHomeGoods(&broken); err == nil {
		t.Fatal("accepted a row naming itself differently from the catalogue")
	}
	broken.Items[0].Name = h.Items[0].Name
	broken.Items[0].Footprint = []int{9, 9}
	if err := resolveHomeGoods(&broken); err == nil {
		t.Fatal("accepted a footprint disagreeing with the catalogue")
	}
	broken.Items[0].Footprint = []int{1, 1, 1}
	if err := ValidateHomestead(broken); err == nil {
		t.Fatal("accepted a malformed footprint")
	}
}
