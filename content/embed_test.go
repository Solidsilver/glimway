package content

import "testing"

func TestSharedContent(t *testing.T) {
	e, err := LoadEconomy()
	if err != nil {
		t.Fatal(err)
	}
	if e.RoadLanterns[0] != "road-1" || e.RoadLanterns[1] != "road-2" || e.RoadLanterns[2] != "road-3" {
		t.Fatal("invalid lantern content")
	}
	gear, err := LoadHabiticaGear()
	if err != nil || len(gear.Gear) == 0 {
		t.Fatalf("gear catalog: %v", err)
	}
	papers, err := LoadPapers()
	if err != nil {
		t.Fatal(err)
	}
	if len(papers) != 52 || len(PapersByID) != 52 {
		t.Fatalf("paper catalog: %d rows", len(papers))
	}
	start := 0
	sections := map[string]int{}
	for _, p := range papers {
		if p.Source == "library-start" {
			start++
		}
		sections[p.Section]++
	}
	// Every shelf sign has papers under it (docs/design/indoors.md 3.3).
	for _, s := range []string{"stories", "histories", "recipes", "field-notes"} {
		if sections[s] == 0 {
			t.Fatalf("library section %s is empty", s)
		}
	}
	if start != 13 {
		t.Fatalf("library-start papers: %d", start)
	}
}

func TestEconomyLoaderVectors(t *testing.T) {
	var vectors struct {
		Loader []loaderVector
	}
	readVectors(t, "economy", &vectors)
	base, _ := FS.ReadFile("economy.json")
	for _, v := range vectors.Loader {
		t.Run("loader/"+v.Name, func(t *testing.T) {
			_, err := DecodeEconomy(editVector(t, base, v))
			if (err == nil) != v.Valid {
				t.Fatal(v.Valid, err)
			}
			if !v.Valid && v.Rule != "" {
				checkVectorRule(t, err, v.Rule)
			}
		})
	}
}
