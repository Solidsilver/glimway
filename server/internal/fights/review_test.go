package fights

import (
	"encoding/json"
	"math"
	"os"
	"testing"
	"time"

	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"
)

// A blow between ticks that puts the camp down queues its fall for the next
// frame; a room stopped before that frame still hands the fall over.
func TestActorHandsOverAFallWhenItClosesBeforeTheNextTick(t *testing.T) {
	r := testRoom(1)
	falls := make(chan Fall, 4)
	a := Start(r, ActorConfig{Now: func() time.Time { return origin }, Ticks: make(chan time.Time), Fall: func(f Fall) { falls <- f }})
	p := player(105, 112)
	a.Submit(Command{Player: &p})
	tick, _ := rules.FightTickAt(origin.UnixMilli())
	reply := make(chan []*wire.FightHitRow, 1)
	a.Submit(Command{Attack: &Attack{ID: 1, Player: p.Observer, Swing: slash(p.X, p.Y, 1, tick), Damage: 1000}, Result: reply})
	if rows := <-reply; len(rows) != 1 || rows[0].Damage <= 0 {
		t.Fatal("the blow did not land", rows)
	}
	a.Stop()
	<-a.Done()
	select {
	case f := <-falls:
		if f.Camp != "camp:0:0:0" || len(f.Witnesses) != 1 {
			t.Fatal("fall", f)
		}
	default:
		t.Fatal("the fall closed with the room")
	}
}

// The signatures' strikes and Shadowstep's dash on open ground follow the
// shared vectors the client's fight-rules.ts is held to.
func TestSignatureVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../content/vectors/fights.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Signatures []struct {
			Kind                                   string
			X, Y, FacingX, FacingY, EnemyX, EnemyY float64
			Travelled, Hit                         bool
		}
		Dash []struct {
			X, Y, FacingX, FacingY, EndX, EndY float64
			Travelled                          bool
		}
	}
	if err = json.Unmarshal(raw, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors.Signatures) < 500 || len(vectors.Dash) < 20 {
		t.Fatal("signature vectors missing")
	}
	for _, v := range vectors.Signatures {
		var s Strike
		switch v.Kind {
		case "cleave":
			s = CleaveStrike(v.X, v.Y, v.FacingX, v.FacingY)
		case "mend":
			s = MendStrike(v.X, v.Y)
		case "snapstrike":
			s = Snapstrike(v.X, v.Y, v.Travelled)
		default:
			t.Fatal("kind", v.Kind)
		}
		if s.Reaches(v.EnemyX, v.EnemyY) != v.Hit {
			t.Fatalf("%+v", v)
		}
	}
	// Open ground everywhere the dash goes: the projected end, as the
	// client predicts it.
	for _, v := range vectors.Dash {
		cx, cy := int(math.Floor(v.X/(24*TilePixels))), int(math.Floor(v.Y/(24*TilePixels)))
		chunks := []Geometry{}
		for dy := -1; dy <= 1; dy++ {
			for dx := -1; dx <= 1; dx++ {
				g := testGeometry()
				g.CX, g.CY = cx+dx, cy+dy
				chunks = append(chunks, g)
			}
		}
		x, y := NewGround(chunks...).Dash(v.X, v.Y, v.FacingX, v.FacingY)
		if math.Abs(x-v.EndX) > 1e-9 || math.Abs(y-v.EndY) > 1e-9 || DashTravelled(x-v.X, y-v.Y) != v.Travelled {
			t.Fatalf("dash %+v: %v,%v", v, x, y)
		}
	}
}

// Ground joins chunks: a dash crosses an open edge, and a wall in the next
// chunk stops it whichever room asks.
func TestGroundDashCrossesChunkEdges(t *testing.T) {
	west, east := testGeometry(), testGeometry()
	west.CX, east.CX = -1, 0
	if x, _ := NewGround(west, east).Dash(-54.5, 112, 1, 0); math.Abs(x-10) > 1e-9 {
		t.Fatal("open edge", x)
	}
	if x, _ := NewGround(west).Dash(-54.5, 112, 1, 0); x > -EnemyRadius+1e-9 {
		t.Fatal("a chunk it does not hold is solid", x)
	}
	east.Open[7*east.Size+0] = false // x 0..16 at y 112..128
	if x, _ := NewGround(west, east).Dash(-54.5, 120, 1, 0); x > -EnemyRadius+1e-9 {
		t.Fatal("wall past the edge", x)
	}
}

// The flight's order: the earliest sample, then the nearer enemy, then the
// lower room; it decides only once sealed and once every other copy has
// looked that far, and a withdrawn copy is never waited on.
func TestFlightPicksOneImpact(t *testing.T) {
	woke := map[uint32]int{}
	f := NewFlight(0, 96)
	for _, room := range []uint32{1, 2, 3} {
		f.Join(room, func() { woke[room]++ })
	}
	f.report(2, 9, &boltHit{k: 9, d2: 50, room: 2})
	f.report(1, 9, &boltHit{k: 9, d2: 50, room: 1})
	if decided, _ := f.verdict(1); decided {
		t.Fatal("decided before sealing")
	}
	f.Seal()
	if decided, _ := f.verdict(1); decided {
		t.Fatal("decided while room 3 has not looked as far")
	}
	f.report(3, 8, nil)
	if decided, _ := f.verdict(1); decided {
		t.Fatal("room 3 looked only to 8")
	}
	f.Withdraw(3)
	decided, won := f.verdict(1)
	if !decided || won == nil || won.room != 1 || woke[1] != 1 || woke[2] != 1 || woke[3] != 0 {
		t.Fatal("tie on sample and distance goes to the lower room, every copy woken", won, woke)
	}
	if _, lost := f.verdict(2); lost != nil {
		t.Fatal("two winners")
	}

	near := NewFlight(0, 96)
	near.Join(1, nil)
	near.Join(2, nil)
	near.Seal()
	near.report(1, 12, &boltHit{k: 12, d2: 10, room: 1})
	near.report(2, 12, &boltHit{k: 12, d2: 4, room: 2})
	if _, won := near.verdict(2); won == nil {
		t.Fatal("the nearer enemy at the same sample")
	}

	walled := NewFlight(0, 0)
	walled.Join(1, nil)
	walled.Seal()
	if decided, won := walled.verdict(1); !decided || won != nil {
		t.Fatal("a bolt that cannot fly misses at once")
	}
	miss := NewFlight(0, 96)
	miss.Join(1, nil)
	miss.Seal()
	miss.report(1, 95, nil)
	if decided, _ := miss.verdict(1); decided {
		t.Fatal("decided before the lifetime")
	}
	miss.report(1, 96, nil)
	if decided, won := miss.verdict(1); !decided || won != nil {
		t.Fatal("a miss", won)
	}
}
