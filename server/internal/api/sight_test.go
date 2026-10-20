package api

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"testing"
	"time"

	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/wilds"
)

// chunkPx is a chunk's width in pixels.
func chunkPx() float64 { return float64(chunkSize() * wildsTileSize) }

// reportPx reports the hero standing at outdoors pixel (px, py).
func (x *rig) reportPx(c *http.Cookie, s response, px, py float64) response {
	x.t.Helper()
	return x.reportState(c, s, 0, 0, map[string]any{"area": outdoorsArea, "x": px, "y": py})
}

// chunkOfPx is the chunk outdoors pixel (px, py) lies in.
func chunkOfPx(px, py float64) (int, int) { return wilds.ChunkOf(wilds.TileOfPixel(px, py)) }

// storedChunks counts the stored chunks within r of (cx, cy).
func (x *rig) storedChunks(cx, cy, r int) int {
	var n int
	if err := x.db.DB.QueryRow("SELECT count(*) FROM wilds_chunks WHERE cx BETWEEN ? AND ? AND cy BETWEEN ? AND ?", cx-r, cx+r, cy-r, cy+r).Scan(&n); err != nil {
		x.t.Fatal(err)
	}
	return n
}

// One report naming a far chunk moves sight no further than the hero could
// have travelled: the near and chunk reads there are refused and nothing is
// made there (review finding 2), wherever the next one jumps.
func TestSightAnchorRefusesAJump(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.putAt(s.AccountID, 20, 60)
	n := x.near(c, 20, 60, 200)
	for _, far := range [][2]int{{4095, 4095}, {-4000, 3000}, {20, 200}} {
		px, py := float64(far[0])*chunkPx()+100, float64(far[1])*chunkPx()+100
		s = x.reportPx(c, s, px, py)
		x.refusal(fmt.Sprintf("/api/wilds/near/%d/%d", far[0], far[1]), c, "beyond-sight")
		x.refusal(fmt.Sprintf("/api/wilds/chunk/%s/0/%d/%d", n.Wick.Id, far[0], far[1]), c, "beyond-sight")
		if got := x.storedChunks(far[0], far[1], 3); got != 0 {
			t.Fatalf("%v: %d chunks made round a jump", far, got)
		}
	}
}

// Walking and riding at the client's real speeds, reporting every 10
// seconds, the near read round the hero always answers, as does a chunk
// read at the window's edge; so does the client's retry after outrunning
// its report (a near read refused beyond-sight, the report flushed, read
// again).
func TestSightFollowsWalkingAndRiding(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.putAt(s.AccountID, 20, 60)
	n := x.near(c, 20, 60, 200)
	px, py := 20*chunkPx()+12*16+8, 60*chunkPx()+12*16+8
	s = x.reportPx(c, s, px, py)
	// Ride east 5 minutes on laid stone (155 × 1.15), then walk north-west.
	for _, leg := range []struct {
		vx, vy  float64
		reports int
	}{{155 * 1.15, 0, 30}, {-110 / math.Sqrt2, -110 / math.Sqrt2, 12}, {0, 155, 12}} {
		for range leg.reports {
			x.now.Add(10)
			px, py = px+leg.vx*10, py+leg.vy*10
			s = x.reportPx(c, s, px, py)
			cx, cy := chunkOfPx(px, py)
			x.near(c, cx, cy, 200)
			x.chunk(c, n.Wick.Id, 0, cx+NearRadius, cy, 200)
		}
	}
	// Outrun the report: 15 seconds of riding (about 7 chunks) unreported.
	x.now.Add(15)
	px += 155 * 1.15 * 15
	cx, cy := chunkOfPx(px, py)
	ax, _ := chunkOfPx(px-155*1.15*15, py)
	if cx-ax <= sightLag {
		t.Fatalf("the hero outran sight by %d chunks only", cx-ax)
	}
	x.refusal(fmt.Sprintf("/api/wilds/near/%d/%d", cx, cy), c, "beyond-sight")
	s = x.reportPx(c, s, px, py)
	x.near(c, cx, cy, 200)
}

// A server's move (a way home, a room's door, the border's settling: any
// place the server writes) starts sight again where it put the hero, at
// once; so does coming back after a while, at the place they left.
func TestSightStartsAgainAtServerMovesAndReconnects(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.putAt(s.AccountID, 20, 60)
	s = x.reportPx(c, s, 20*chunkPx()+200, 60*chunkPx()+200)
	// The server writes a far place (as rooms, MovePlace and a way home do).
	x.putAt(s.AccountID, -300, 900)
	x.near(c, -300, 900, 200)
	// A way home's turncap from far out lands at the arch, and sight with it.
	x.putAt(s.AccountID, 60, 20)
	s = x.reportPx(c, s, 60*chunkPx()+200, 20*chunkPx()+200)
	x.stack(s.AccountID, "homing-turncap", "", 1)
	req := &contract.WaysHomeRequest{Op: opHeader(s.Lease, "sight-turncap"), Where: &contract.Where{Area: outdoorsArea, X: 60*chunkPx() + 200, Y: 20*chunkPx() + 200}, Action: waysTurncap}
	env, _ := x.call("/api/ways-home", req, c, 200)
	p := env.GetState().GetPlace()
	acx, acy := chunkOfPx(p.GetX(), p.GetY())
	if max(abs(acx-60), abs(acy-20)) <= sightChunks {
		t.Fatalf("the arch at %d,%d isn't far enough to tell", acx, acy)
	}
	x.near(c, acx, acy, 200)
	// Reconnecting an hour later where they left off, and walking on.
	x.now.Add(3600)
	s = x.reportPx(c, s, p.GetX()+300, p.GetY())
	x.near(c, acx, acy, 200)
}

// The still epoch (the Tangle) reads from anywhere; past sight a chunk
// someone walked reads (it is stored), one nobody did is refused and not
// made (review finding 4); a held one reads as before.
func TestChunkReadsPastSight(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	const cx, cy = 4, -8
	x.putAt(s.AccountID, cx, cy)
	n := x.near(c, cx, cy, 200)
	x.putAt(s.AccountID, 200, 200)
	x.chunk(c, n.Still.Id, 0, 0, -1, 200)
	x.chunk(c, n.Wick.Id, 0, cx, cy+1, 200)
	x.refusal("/api/wilds/chunk/"+n.Wick.Id+"/0/4/-30", c, "beyond-sight")
	if x.storedChunks(4, -30, 0) != 0 {
		t.Fatal("a refused read made the chunk")
	}
}

// Fight wake (the presence socket) makes no chunk past the player's
// anchor, wherever the socket says they stand: the guard refuses it.
func TestSightGuardRefusesFarMaking(t *testing.T) {
	x := newRig(t)
	_, s := x.ready("alice")
	x.putAt(s.AccountID, 20, 60)
	g := &sightGuard{a: x.api, account: s.AccountID, now: func() time.Time { return time.Unix(x.now.Load(), 0) }}
	tx, err := x.db.DB.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err = g.AllowMake(context.Background(), tx, "wick", 20+sightChunks, 60); err != nil {
		t.Fatal("within sight:", err)
	}
	if err = g.AllowMake(context.Background(), tx, "wick", 20+sightChunks+1, 60); err != errBeyondSight {
		t.Fatal("past sight:", err)
	}
	if err = g.AllowMake(context.Background(), tx, "still", 0, -1); err != nil {
		t.Fatal("the Tangle:", err)
	}
}

// Each reader makes at most makeBurst new chunks at once and makeRate a
// second after; an honest rider makes about three a second.
func TestMakeBudget(t *testing.T) {
	var b makeBudget
	at := time.Unix(1_800_000_000, 0)
	for i := range int(makeBurst) {
		if !b.take("alice", at) {
			t.Fatalf("refused the %dth chunk of a burst", i+1)
		}
	}
	if b.take("alice", at) {
		t.Fatal("past the burst")
	}
	if !b.take("bob", at) {
		t.Fatal("one reader's budget spent another's")
	}
	at = at.Add(time.Second)
	for range int(makeRate) {
		if !b.take("alice", at) {
			t.Fatal("not refilled")
		}
	}
	if b.take("alice", at) {
		t.Fatal("refilled past the rate")
	}
}
