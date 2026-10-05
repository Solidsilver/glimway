package content

import "testing"

func TestSharedContent(t *testing.T) {
	e, err := LoadEconomy()
	if err != nil {
		t.Fatal(err)
	}
	if e.QuestEmbers["defeat-guardian"] != 2 || e.QuestEmbers["return-village"] != 3 || e.RoadLanterns[0] != "road-1" || e.RoadLanterns[1] != "road-2" || e.RoadLanterns[2] != "road-3" {
		t.Fatal("invalid quest/lantern content")
	}
	gear, err := LoadGear()
	if err != nil || len(gear) == 0 {
		t.Fatalf("gear catalog: %v", err)
	}
	papers, err := LoadPapers()
	if err != nil {
		t.Fatal(err)
	}
	if len(papers) != 39 || len(PapersByID) != 39 {
		t.Fatalf("paper catalog: %d rows", len(papers))
	}
	start := 0
	for _, p := range papers {
		if p.Source == "library-start" {
			start++
		}
	}
	if start != 11 {
		t.Fatalf("library-start papers: %d", start)
	}
}
