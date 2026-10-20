package api

import (
	"fmt"
	"net/http"
	"testing"

	"glimway/server/internal/chunks"
	"glimway/server/internal/frontier"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
)

// Upkeep boundary tests (step-back S1–S3). Each action here is the first
// request after a boundary, with no state read before it. opRefreshing
// reads the state first, and that read does the upkeep, so it would hide an
// action that doesn't do its own; these call the endpoint raw instead, and
// check that a read first changes nothing.

// dueLapse: alice's gate-0 lantern lit with one wick of oil and a sapling
// planted in its backland; two turnings read (it burns, then dims), and a
// third due but unread, at which the lantern goes dark and the backland
// lapses. The planted sapling, and where alice stands beside it.
func (x *rig) dueLapse() (*http.Cookie, response, string, [2]int, rules.State) {
	x.t.Helper()
	c, s := x.ready("alice")
	x.claimGate(c, &s, 0)
	x.fund(s.AccountID, 200, 0)
	x.stack(s.AccountID, "hearth-oil", "", 1)
	ox, oy := chunks.LotOrigin(0)
	sx, sy := atStake(0)
	x.lanternOp(c, &s, 0, sx, sy, 200)
	at := x.backlandSpots(s.WorldID, 0)[2]
	tile := [2]int{ox + at[0], oy + at[1]}
	stand := standAt(s, "outdoors", tile[0], tile[1])
	x.stack(s.AccountID, "birch-sapling", "", 1)
	p := x.opRefreshing(c, &s, "plant", map[string]any{"itemDef": "birch-sapling", "tile": tile, "progress": stand}, 200).Result.Plant
	if p == nil {
		x.t.Fatal("not planted")
	}
	for range 2 {
		x.turnKeepingSession(s.AccountID)
		x.refresh(c, &s)
	}
	if l := x.lanternOf(0, s.WorldID); !l.Lit || !l.Dimming {
		x.t.Fatalf("not dimming before the lapse: %+v", l)
	}
	x.turnKeepingSession(s.AccountID)
	return c, s, p.ID, tile, stand
}

// turnKeepingSession is turn with the account's session moved on by as
// long, so the next request needs no sign-in (which reads the state).
func (x *rig) turnKeepingSession(account string) {
	x.t.Helper()
	was := x.now.Load()
	x.turn()
	if _, err := x.db.DB.Exec("UPDATE sessions SET created_at=created_at+?1,expires_at=expires_at+?1 WHERE account_id=?2", x.now.Load()-was, account); err != nil {
		x.t.Fatal(err)
	}
}

// rawItem is one item mutation as a client sends it, with no read first.
func (x *rig) rawItem(c *http.Cookie, s response, op string, fields map[string]any, status int) itemsResponse {
	x.t.Helper()
	return x.items("POST", "/api/items/"+op, body(s, fmt.Sprintf("%s-raw-%d", op, keySeq()), fields), c, status)
}

// The trowel can't dig up a backland plant whose lapse is due (S2): the
// lapse comes first, the plant goes to seed in home storage as a dark
// backland's do (lamps.md), and none is carried, whether or not a state
// read came first.
func TestTrowelAfterADueLapse(t *testing.T) {
	for _, readFirst := range []bool{false, true} {
		t.Run(fmt.Sprintf("readFirst=%v", readFirst), func(t *testing.T) {
			x := newRig(t)
			c, s, plant, _, stand := x.dueLapse()
			x.instance(s.AccountID, "bench-trowel", -1, "")
			if readFirst {
				x.refresh(c, &s)
			}
			if code := x.rawItem(c, s, "uproot", map[string]any{"target": plant, "progress": stand}, 409).Error.Code; code != "not-your-land" {
				t.Fatalf("uprooted after the lapse: %s", code)
			}
			x.lapsedToSeed(s)
		})
	}
}

// Nor can a seed go into it (planting already judged the turning first).
func TestPlantAfterADueLapse(t *testing.T) {
	x := newRig(t)
	c, s, _, tile, stand := x.dueLapse()
	x.stack(s.AccountID, "birch-sapling", "", 1)
	if code := x.rawItem(c, s, "plant", map[string]any{"itemDef": "birch-sapling", "tile": [2]int{tile[0] + 1, tile[1]}, "progress": stand}, 409).Error.Code; code != "cannot-plant-here" {
		t.Fatalf("planted after the lapse: %s", code)
	}
	x.lapsedToSeed(s)
}

// lapsedToSeed: the backland lapsed; its one plant went to seed in home
// storage, and alice carries no plant.
func (x *rig) lapsedToSeed(s response) {
	x.t.Helper()
	if l := x.lanternOf(0, s.WorldID); l.Lit {
		x.t.Fatalf("still lit: %+v", l)
	}
	var carried, planted, seeds int
	if err := x.db.DB.QueryRow("SELECT count(*) FROM carried_plants WHERE account_id=?", s.AccountID).Scan(&carried); err != nil {
		x.t.Fatal(err)
	}
	if err := x.db.DB.QueryRow("SELECT count(*) FROM homestead_plants p JOIN homesteads h ON h.id=p.homestead_id WHERE h.world_id=? AND h.gate=0", s.WorldID).Scan(&planted); err != nil {
		x.t.Fatal(err)
	}
	if err := x.db.DB.QueryRow("SELECT COALESCE(SUM(qty),0) FROM item_stacks s JOIN homesteads h ON h.id=s.owner WHERE s.location='storage' AND h.world_id=? AND h.gate=0 AND s.item_def='birch-sapling'", s.WorldID).Scan(&seeds); err != nil {
		x.t.Fatal(err)
	}
	if carried != 0 || planted != 0 || seeds != 1 {
		x.t.Fatalf("after the lapse: %d carried, %d planted, %d seeds in storage", carried, planted, seeds)
	}
}

// A near read in a camp's slack, first after the turning its camp lapses
// at, is beyond the frontier: the read judges the turning before it checks
// the frontier, and keeps that judgement when it refuses, so straight after
// the refusal nothing is held and the slack is gone for everyone. A read
// first changes nothing.
func TestNearReadAfterADueLapse(t *testing.T) {
	for _, readFirst := range []bool{false, true} {
		t.Run(fmt.Sprintf("readFirst=%v", readFirst), func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			x.keeper(s.AccountID)
			ex, ey := reachColumn(t)
			x.stack(s.AccountID, "hearth-oil", "", 1)
			spots := x.campSpots(s.WorldID, ex, ey)
			x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: x.carry(s.AccountID, "way-lamp"), X: int32(spots[0][0]), Y: int32(spots[0][1])}, spots[1][0], spots[1][1], 200)
			x.near(c, ex, ey-2, 200)
			// Guttering, empty: it lapses at the next turning.
			if _, err := x.db.DB.Exec("UPDATE camps SET oil=0,dimming=1 WHERE world_id=?", s.WorldID); err != nil {
				t.Fatal(err)
			}
			x.turnKeepingSession(s.AccountID)
			if readFirst {
				x.refresh(c, &s)
			}
			for i := range 2 {
				x.near(c, ex, ey-2, 409)
				var held int
				if err := x.db.DB.QueryRow("SELECT count(*) FROM holds WHERE world_id=?", s.WorldID).Scan(&held); err != nil {
					t.Fatal(err)
				}
				if held != 0 || frontier.Inside(s.WorldID, ex, ey-2) || frontier.InsidePublished(s.WorldID, ex, ey-2) {
					t.Fatalf("after refused read %d: %d holds, reach %v, published %v", i+1, held, frontier.Inside(s.WorldID, ex, ey-2), frontier.InsidePublished(s.WorldID, ex, ey-2))
				}
			}
		})
	}
}
