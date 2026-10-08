package story

import (
	"context"
	"database/sql"
	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/ports"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"testing"
	"time"
)

func TestEchoAssignmentRestrictionsAndStability(t *testing.T) {
	r := Rules{}
	s := store.Snapshot{State: rules.NewState()}
	in := ports.EchoInput{Epoch: &contract.WildsEpoch{WorldSeed: "seed", RegionId: "outer-1", Season: "Mudrise"}}
	for i := 0; i < 12; i++ {
		in.Sites = append(in.Sites, ports.EchoSite{CX: int32(i % 3), Site: &contract.StorySite{Id: string(rune('a' + i)), Kind: contract.SiteKind_SITE_KIND_ECHO}})
	}
	check := func(late bool) {
		out, err := r.Echoes(context.Background(), nil, s, in)
		if err != nil {
			t.Fatal(err)
		}
		used := map[string]bool{}
		for _, a := range out {
			if used[a.Member] {
				t.Fatal("member assigned twice")
			}
			used[a.Member] = true
			for _, site := range in.Sites {
				if site.Site.Id == a.Site && a.Member == "tam" && site.CX != 2 {
					t.Fatal("Tam outside east")
				}
			}
			if !late && (a.Member == "tam" || a.Member == "bett") {
				t.Fatal("twins before road lit")
			}
		}
		if late && len(used) != 6 || !late && len(used) != 4 {
			t.Fatal(used)
		}
		// A settled member keeps its assignment and becomes settled there.
		s.State.Flags = []string{"echo:nan"}
		again, _ := r.Echoes(context.Background(), nil, s, in)
		if store.JSON(out) == store.JSON(again) {
			t.Fatal("settlement absent")
		}
		for i, a := range out {
			if a.Site != again[i].Site || a.Member != again[i].Member {
				t.Fatal("assignment changed")
			}
		}
		s.State.Flags = nil
	}
	check(false)
	s.State.Quest = "complete"
	check(true)
}

func TestPaperFactsSitesEchoesAndTurning(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	_, err = db.Exec(`CREATE TABLE project_papers(account_id TEXT,paper_id TEXT);
 CREATE TABLE homestead_members(account_id TEXT,homestead_id TEXT);
 CREATE TABLE homesteads(id TEXT,tier INTEGER);
 CREATE TABLE homestead_items(homestead_id TEXT,item_def TEXT,location TEXT);
 CREATE TABLE personal_claims(epoch TEXT,entity_id TEXT,account_id TEXT);
 CREATE TABLE player_place(account_id TEXT,last_outer_epoch TEXT,last_outer_starts_at REAL);
 INSERT INTO player_place VALUES('a','',NULL);`)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	now := int64(1791400000)
	epoch := &contract.WildsEpoch{Id: "e1", GeneratorVersion: 2, WorldSeed: "seed", RegionId: "outer-1", Season: "Mudrise", StartsAt: float64(now)}
	es := &chunks.FakeEpochs{Values: map[chunks.EpochKey]*contract.WildsEpoch{{World: "w", Region: "outer-1"}: epoch}}
	source := &chunks.Fake{Chunks: map[chunks.Key]*contract.WildsChunk{}}
	for cy := 0; cy < 3; cy++ {
		for cx := 0; cx < 3; cx++ {
			source.Chunks[chunks.Key{World: "w", Epoch: "e1", CX: int32(cx), CY: int32(cy)}] = &contract.WildsChunk{Size: 24, Cx: int32(cx), Cy: int32(cy), Mark: "Mudrise"}
		}
	}
	site := &contract.StorySite{Id: "cairn", Kind: contract.SiteKind_SITE_KIND_CAIRN, Tx: 3, Ty: 4}
	source.Chunks[chunks.Key{World: "w", Epoch: "e1", CX: 0, CY: 0}].Sites = []*contract.StorySite{site}
	r := Rules{Chunks: source, Epochs: es, Now: func() time.Time { return time.Unix(now, 0) }}
	s := store.Snapshot{AccountID: "a", WorldID: "w", State: rules.NewState()}
	eligible := func(id string, w *contract.Where, want bool) {
		t.Helper()
		got, e := r.Eligible(context.Background(), tx, s, ports.PaperInput{Paper: id, Where: w, Epoch: "e1", Site: site.Id})
		if e != nil || got != want {
			t.Fatalf("%s: %v, %v (want %v)", id, got, e, want)
		}
	}
	// Curated paper reach and stage, and a handed-over paper's stage.
	p := content.PapersByID["pip-copybook-warden-corrections"].Rule
	w := &contract.Where{Area: p.Area, X: float64(p.TX*16 + 8), Y: float64(p.TY*16 + 8)}
	eligible("pip-copybook-warden-corrections", w, true)
	s.State.Quest = "accepted"
	eligible("pip-copybook-warden-corrections", w, true)
	w.X += 100
	eligible("pip-copybook-warden-corrections", w, false)
	w = &contract.Where{Area: "village"}
	eligible("ashwatch-ledger-excerpts", w, false)
	s.State.Quest = "clue-found"
	eligible("ashwatch-ledger-excerpts", w, true)
	eligible("joss-penhallow-letter-map-case", w, false)
	if _, e := r.Grant(context.Background(), tx, &s, "joss-penhallow-letter-map-case", now); e == nil {
		t.Fatal("unbuilt grant")
	}
	w = &contract.Where{Area: "commons"}
	for _, p := range content.PapersByID {
		if p.Source == "commons" && (p.Rule.Fact == "plot" || p.Rule.Fact == "foundation" || p.Rule.Fact == "door-fox") {
			eligible(p.ID, w, false)
		}
	}
	tx.Exec("INSERT INTO homestead_members VALUES('a','h'); INSERT INTO homesteads VALUES('h',1); INSERT INTO homestead_items VALUES('h','door-fox','placed')")
	for _, p := range content.PapersByID {
		if p.Source == "commons" && (p.Rule.Fact == "plot" || p.Rule.Fact == "foundation" || p.Rule.Fact == "door-fox") {
			eligible(p.ID, w, true)
		}
	}
	w = &contract.Where{Area: "wilds:outer-1", X: 56, Y: 72}
	eligible("mary-fenns-cairn-slip", w, false)
	s.State.Flags = []string{"paper:will-of-elias-fenn"}
	eligible("mary-fenns-cairn-slip", w, true)
	w.X += 100
	eligible("mary-fenns-cairn-slip", w, false)
	// Echo papers are due only for a settled member at that player's assigned site.
	s.State.Quest = "complete"
	var echoSites []ports.EchoSite
	for i := 0; i < 9; i++ {
		cx, cy := int32(i%3), int32(i/3)
		e := &contract.StorySite{Id: string(rune('a' + i)), Kind: contract.SiteKind_SITE_KIND_ECHO, Tx: 8, Ty: 8}
		m := source.Chunks[chunks.Key{World: "w", Epoch: "e1", CX: cx, CY: cy}]
		m.Sites = append(m.Sites, e)
		echoSites = append(echoSites, ports.EchoSite{Site: e, CX: cx, CY: cy})
	}
	assignments, _ := r.Echoes(context.Background(), tx, s, ports.EchoInput{Epoch: epoch, Sites: echoSites})
	for _, p := range content.PapersByID {
		if p.Source == "echo" {
			var assigned *contract.EchoAssignment
			for _, a := range assignments {
				if a.Member == p.Rule.Member {
					assigned = a
				}
			}
			if assigned == nil {
				t.Fatal("paper member not assigned", p.ID)
			}
			var at ports.EchoSite
			for _, e := range echoSites {
				if e.Site.Id == assigned.Site {
					at = e
				}
			}
			where := &contract.Where{Area: "wilds:outer-1", X: float64((int(at.CX)*24+8)*16 + 8), Y: float64((int(at.CY)*24+8)*16 + 8)}
			input := ports.PaperInput{Paper: p.ID, Epoch: "e1", Site: assigned.Site, Where: where}
			if due, e := r.Eligible(context.Background(), tx, s, input); e != nil || due {
				t.Fatal("unsettled Echo paper", due, e)
			}
			s.State.Flags = append(s.State.Flags, "echo:"+p.Rule.Member)
			if due, e := r.Eligible(context.Background(), tx, s, input); e != nil || !due {
				t.Fatal("settled Echo paper", due, e)
			}
			input.Site = "not-assigned"
			if due, e := r.Eligible(context.Background(), tx, s, input); e != nil || due {
				t.Fatal("wrong assignment", due, e)
			}
		}
	}
	s.State.Flags = []string{"paper:will-of-elias-fenn"}
	// Observing an initial epoch establishes the watermark without a turning.
	s.State.Quest = "complete"
	w.X = 56
	if err = r.Record(context.Background(), tx, &s, w, now); err != nil {
		t.Fatal(err)
	}
	if len(s.State.Flags) != 1 {
		t.Fatal(s.State.Flags)
	}
	epoch.Id = "e2"
	epoch.StartsAt++
	if err = r.Record(context.Background(), tx, &s, w, now+1); err != nil {
		t.Fatal(err)
	}
	if !contains(s.State.Flags, "wilds:turned") || !contains(s.State.Flags, "paper:weir-effect-survey-draft") {
		t.Fatal(s.State.Flags)
	}
	board := content.StoryRules.Boards["commons"]
	eligible("notices-from-the-board", &contract.Where{Area: "commons", X: float64(board.TX*16 + 8), Y: float64(board.TY*16 + 8)}, true)
	eligible("notices-from-the-board", &contract.Where{Area: "commons", X: 0, Y: 0}, false)
	before := store.JSON(s.State.Flags)
	epoch.Id = "old"
	epoch.StartsAt -= 2
	r.Record(context.Background(), tx, &s, w, now+2)
	if store.JSON(s.State.Flags) != before {
		t.Fatal("older epoch moved turning")
	}
}
func contains(v []string, s string) bool {
	for _, x := range v {
		if x == s {
			return true
		}
	}
	return false
}
