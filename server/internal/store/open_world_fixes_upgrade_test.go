package store

import (
	"bufio"
	"context"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/wilds"
	"glimway/server/internal/wildsgen"
)

// oldWickChunks reads testdata/open_world_old_chunks.txt: real terrain from
// the generator before the open world (c5f2c111), world seed "seed-world-a",
// season "t:1795000000:1795604800", epoch id "now", one "cx cy hexblob" a line.
func oldWickChunks(t *testing.T) map[[2]int][]byte {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", "open_world_old_chunks.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	out := map[[2]int][]byte{}
	sc := bufio.NewScanner(f)
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		p := strings.Fields(sc.Text())
		cx, _ := strconv.Atoi(p[0])
		cy, _ := strconv.Atoi(p[1])
		b, err := hex.DecodeString(p[2])
		if err != nil {
			t.Fatal(err)
		}
		out[[2]int{cx, cy}] = b
	}
	if err = sc.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// A wick chunk held this wick, on terrain made before the open world, keeps
// its body; its unheld neighbour is made again by today's generator and
// mirrors the held edge (findings 1 and 3 of open-world-review-sol.md). The
// remade neighbour's objects start fresh: no depletion, fall, claim or chart
// carried over from the old objects at the same ids. The held chunk's state,
// the still epoch's, places found, the rumour's find and ground changes stay.
// Run as the live game will (039 and 040 together) and as staging did (039
// first, a neighbour then made beside the hold without its edges).
func TestUpgradeOpenWorldFixesKeepHeldEdgesAndFreshObjects(t *testing.T) {
	for _, through := range []string{"038_lamps.sql", "039_open_world.sql"} {
		t.Run(through, func(t *testing.T) { upgradeOpenWorldFixes(t, through) })
	}
}

func upgradeOpenWorldFixes(t *testing.T, through string) {
	const start, end = 1795000000, 1795604800
	old := oldWickChunks(t)
	held, west := [2]int{7, 2}, [2]int{6, 2}
	path := filepath.Join(t.TempDir(), "upgrade.sqlite")
	db := newUpgradeFixture(t, path, through, nil)
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(q, args...); err != nil {
			t.Fatal(q, err)
		}
	}
	exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','seed-world-a',1);
 INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at) VALUES('alice','Alice','w',1,1);`)
	exec("INSERT INTO wild_epochs(id,world_id,kind,world_seed,generator_version,season,starts_at,ends_at) VALUES('still','w','still','seed-world-a',3,'0',1,NULL),('now','w','wick','seed-world-a',3,?,?,?)", "t:"+strconv.Itoa(start)+":"+strconv.Itoa(end), start, end)
	for _, c := range [][2]int{held, west} {
		blob := old[c]
		if through == "039_open_world.sql" && c == west {
			// Staging after 039: the west neighbour was made again
			// without the held edge. Any body will do: 040 drops it.
			blob = []byte{}
		}
		exec("INSERT INTO wilds_chunks(epoch_id,layer,cx,cy,generator_version,blob,created_at) VALUES('now',0,?,?,3,?,?)", c[0], c[1], blob, start+1)
	}
	exec("INSERT INTO holds(world_id,realm,layer,cx,cy,epoch_id,holder_kind,holder_id,since) VALUES('w','hearthwick',0,?,?,'now','way-lamp','lamp-1',?)", held[0], held[1], start+2)
	// Every old object of both chunks was taken: harvested or cleared,
	// claimed, charted; every camp fell and was claimed.
	ids := map[[2]int][]string{}
	for _, c := range [][2]int{held, west} {
		m := &contract.WorldChunk{}
		if err := proto.Unmarshal(old[c], m); err != nil {
			t.Fatal(err)
		}
		for _, e := range m.Entities {
			ids[c] = append(ids[c], e.Id)
			exec("INSERT INTO entity_state(epoch,entity_id,cycle,state,available_at,by_id,at) VALUES('now',?,1,'cleared',?,'alice',?)", e.Id, end, start+3)
			exec("INSERT INTO personal_claims VALUES('now',?,'alice',?)", e.Id, start+3)
			exec("INSERT INTO discoveries VALUES('now',?,'old-poi','alice',?)", e.Id, start+3)
			if e.Kind == "camp" {
				exec("INSERT INTO fight_falls VALUES('w','hearthwick',0,?,?,'now',?,0,?)", c[0], c[1], e.Id, start+3)
				exec("INSERT INTO fight_fall_witnesses VALUES('w','hearthwick',0,?,?,'now',?,0,'alice')", c[0], c[1], e.Id)
				exec("INSERT INTO camp_claims VALUES('now',?,0,'alice',?)", e.Id, start+4)
			}
		}
		if len(ids[c]) == 0 {
			t.Fatalf("old chunk %v has no objects to carry state", c)
		}
	}
	exec(`INSERT INTO entity_state(epoch,entity_id,cycle,state,available_at,by_id,at) VALUES('still','node:0:-1:0',1,'harvested',0,'alice',5);
 INSERT INTO discoveries VALUES('now','place:-2:0','glade','alice',5),('now','rumour:6:2','rumour','alice',5);
 INSERT INTO personal_claims VALUES('now','rumour:6:2','alice',5);`)
	exec("INSERT INTO world_changes(world_id,realm,layer,chunk,epoch,entity,kind,state,changed_at,changed_by,ends_at) VALUES('w','hearthwick',0,'6:2','now','ground','ground','{\"changes\":[]}',?,'alice',?)", start+5, end)
	db.Close()

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	count := func(q string, args ...any) int {
		t.Helper()
		var n int
		if err := s.DB.QueryRow(q, args...).Scan(&n); err != nil {
			t.Fatal(q, err)
		}
		return n
	}

	c := NewChunks(func() time.Time { return time.Unix(start+100, 0) }, wildsgen.V3{})
	ctx := context.Background()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	h, err := c.Chunk(ctx, tx, "w", "now", 0, int32(held[0]), int32(held[1]))
	if err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(h, mustChunk(t, old[held])) {
		t.Fatal("the held chunk's body changed")
	}
	w, err := c.Chunk(ctx, tx, "w", "now", 0, int32(west[0]), int32(west[1]))
	if err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}

	// Edge access: every open tile in the held chunk's two west columns
	// (corners aside) is open across the edge, in the mirror.
	S := int(h.Size)
	open := 0
	for y := 2; y < S-2; y++ {
		for x := range 2 {
			if !wilds.Walkable(h, x, y) {
				continue
			}
			open++
			if !wilds.Walkable(w, S-1-x, y) {
				t.Errorf("held open tile %d,%d faces solid ground at %d,%d", x, y, S-1-x, y)
			}
		}
	}
	if open == 0 {
		t.Fatal("the held chunk's west edge has no open tile to check")
	}

	// The remade objects start fresh; the held chunk's keep their state.
	reused := 0
	for _, e := range w.Entities {
		reused++
		for _, table := range []string{"entity_state", "personal_claims", "discoveries", "camp_claims"} {
			if n := count("SELECT count(*) FROM "+table+" WHERE epoch='now' AND entity_id=?", e.Id); n != 0 {
				t.Errorf("remade %s carries %d old %s rows", e.Id, n, table)
			}
		}
		if n := count("SELECT count(*) FROM fight_falls WHERE epoch='now' AND entity_id=?", e.Id); n != 0 {
			t.Errorf("remade camp %s has already fallen", e.Id)
		}
	}
	if reused == 0 {
		t.Fatal("the remade chunk has no objects")
	}
	for _, id := range ids[west] {
		if n := count("SELECT count(*) FROM entity_state WHERE epoch='now' AND entity_id=?", id); n != 0 {
			t.Errorf("old object %s of the remade chunk kept its state", id)
		}
	}
	for _, id := range ids[held] {
		if n := count("SELECT count(*) FROM entity_state WHERE epoch='now' AND entity_id=? AND state='cleared' AND cycle=1", id); n != 1 {
			t.Errorf("held %s lost its state", id)
		}
		if n := count("SELECT count(*) FROM personal_claims WHERE epoch='now' AND entity_id=?", id) + count("SELECT count(*) FROM discoveries WHERE epoch='now' AND entity_id=?", id); n != 2 {
			t.Errorf("held %s lost its claim or chart", id)
		}
		if strings.HasPrefix(id, "camp:") {
			if n := count("SELECT count(*) FROM fight_falls WHERE epoch='now' AND entity_id=?", id) + count("SELECT count(*) FROM fight_fall_witnesses WHERE epoch='now' AND entity_id=?", id) + count("SELECT count(*) FROM camp_claims WHERE epoch='now' AND entity_id=?", id); n != 3 {
				t.Errorf("held camp %s lost its fall", id)
			}
		}
	}
	if n := count("SELECT count(*) FROM entity_state WHERE epoch='still'"); n != 1 {
		t.Errorf("still state: %d", n)
	}
	if n := count("SELECT count(*) FROM discoveries WHERE entity_id IN ('place:-2:0','rumour:6:2')") + count("SELECT count(*) FROM personal_claims WHERE entity_id='rumour:6:2'"); n != 3 {
		t.Errorf("places found and the rumour's find: %d rows, want 3", n)
	}
	if n := count("SELECT count(*) FROM world_changes WHERE chunk='6:2' AND changed_by='alice'"); n != 1 {
		t.Errorf("ground changes: %d", n)
	}
}

func mustChunk(t *testing.T, b []byte) *contract.WorldChunk {
	t.Helper()
	m := &contract.WorldChunk{}
	if err := proto.Unmarshal(b, m); err != nil {
		t.Fatal(err)
	}
	return m
}

