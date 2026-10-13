package fights

import (
	wire "glimway/server/internal/gen/glimway/v2"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestActorExitAnswersQueuedCommands(t *testing.T) {
	for _, cause := range []string{"stop", "epoch"} {
		t.Run(cause, func(t *testing.T) {
			r := testRoom(1)
			var ms atomic.Int64
			ms.Store(origin.UnixMilli())
			if cause == "epoch" {
				r.EndsAt = origin.Add(time.Second).UnixMilli()
			}
			entered, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			a := Start(r, ActorConfig{Now: func() time.Time { return time.UnixMilli(ms.Load()) }, Ticks: make(chan time.Time), Emit: func(out Output) {
				if _, ok := out.Message.(*wire.FightJoin); ok {
					once.Do(func() { close(entered); <-release })
				}
			}})
			var unblock sync.Once
			t.Cleanup(func() { unblock.Do(func() { close(release) }); a.Stop(); <-a.Done() })
			p := player(105, 112)
			a.Submit(Command{Player: &p})
			<-entered
			replies := []chan []*wire.FightHitRow{}
			for n := 0; n < 32; n++ {
				reply := make(chan []*wire.FightHitRow, 1)
				replies = append(replies, reply)
				if !a.Submit(Command{Attack: &Attack{ID: uint64(n), Player: p.Observer, Swing: slash(p.X, p.Y, uint32(n), 1000), Damage: 1}, Result: reply}) {
					t.Fatal("queue rejected setup")
				}
			}
			if cause == "stop" {
				a.Stop()
				if a.Submit(Command{}) {
					t.Fatal("stopping actor admitted command")
				}
			} else {
				ms.Add(1000)
			}
			unblock.Do(func() { close(release) })
			for _, reply := range replies {
				select {
				case rows := <-reply:
					if len(rows) != 0 {
						t.Fatal("exit judged queued swing", rows)
					}
				case <-time.After(time.Second):
					t.Fatal("queued command stranded on exit")
				}
			}
			select {
			case <-a.Done():
			case <-time.After(time.Second):
				t.Fatal("actor did not exit")
			}
		})
	}
}

func TestActorHandsOffSlashFallBeforeAttackResult(t *testing.T) {
	r := testRoom(1)
	r.enemies[0].x = 120
	r.enemies[0].y = 112
	r.enemies[0].row.Hp = 1
	fall, release := make(chan struct{}), make(chan struct{})
	var unblock sync.Once
	a := Start(r, ActorConfig{Now: func() time.Time { return origin }, Ticks: make(chan time.Time), Fall: func(Fall) {
		close(fall)
		<-release
	}})
	t.Cleanup(func() { unblock.Do(func() { close(release) }); a.Stop(); <-a.Done() })
	p := player(100, 112)
	a.Submit(Command{Player: &p})
	reply := make(chan []*wire.FightHitRow, 1)
	if !a.Submit(Command{Attack: &Attack{ID: 1, Player: p.Observer, Swing: slash(p.X, p.Y, 0, 1000, &wire.FightTarget{Room: 1, Enemy: 0}), Damage: 100}, Result: reply}) {
		t.Fatal("attack rejected")
	}
	select {
	case <-fall:
	case <-time.After(time.Second):
		t.Fatal("slash did not hand off its fall")
	}
	select {
	case rows := <-reply:
		t.Fatal("attack result published before fall handoff finished", rows)
	default:
	}
	unblock.Do(func() { close(release) })
	select {
	case rows := <-reply:
		if len(rows) == 0 || rows[0].RefusedReason != 0 {
			t.Fatal("attack result", rows)
		}
	case <-time.After(time.Second):
		t.Fatal("attack result was not answered")
	}
}

func TestActorHandsOffSettledBoltFallBeforeAttackResult(t *testing.T) {
	r := testRoom(1)
	r.falls = []Fall{{Camp: "camp:0:0:0", Cycle: 0}}
	fall, release := make(chan struct{}), make(chan struct{})
	var unblock sync.Once
	reply := make(chan []*wire.FightHitRow, 1)
	a := &Actor{r: r, c: ActorConfig{Fall: func(Fall) { close(fall); <-release }}, pending: map[uint64]chan<- []*wire.FightHitRow{7: reply}}
	t.Cleanup(func() { unblock.Do(func() { close(release) }) })
	rows := []*wire.FightHitRow{{Room: 1, Enemy: 0, Damage: 1}}
	done := make(chan struct{})
	go func() { a.settled([]BoltResult{{ID: 7, Hits: rows}}); close(done) }()
	select {
	case <-fall:
	case <-time.After(time.Second):
		t.Fatal("settlement did not hand off its fall")
	}
	select {
	case got := <-reply:
		t.Fatal("settled attack result published before fall handoff finished", got)
	default:
	}
	unblock.Do(func() { close(release) })
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("settlement did not finish")
	}
	select {
	case got := <-reply:
		if len(got) != 1 || got[0].Damage != 1 {
			t.Fatal("settled result", got)
		}
	case <-time.After(time.Second):
		t.Fatal("settled result was not answered")
	}
}

func TestActorLeaveBypassesFullQueueWithoutStoppingOthers(t *testing.T) {
	r := testRoom(1)
	entered, release := make(chan struct{}), make(chan struct{})
	observed := make(chan struct{})
	var first, unblock sync.Once
	a := Start(r, ActorConfig{Now: func() time.Time { return origin }, Ticks: make(chan time.Time), Emit: func(out Output) {
		if join, ok := out.Message.(*wire.FightJoin); ok {
			if out.Observer == "socket-a" {
				first.Do(func() { close(entered); <-release })
			}
			if out.Observer == "socket-b" {
				if r.players["socket-a"] != nil {
					t.Error("withdrawn queued cover retained departed player")
				}
				if join.Room != 1 {
					t.Error("room changed")
				}
				close(observed)
			}
		}
	}})
	t.Cleanup(func() { unblock.Do(func() { close(release) }); a.Stop(); <-a.Done() })
	p := player(105, 112)
	a.Submit(Command{Player: &p})
	<-entered
	// Fill with stale covers; Leave must invalidate them even if selected first.
	for range 128 {
		if !a.Submit(Command{Player: &p}) {
			t.Fatal("setup queue did not fill")
		}
	}
	if a.Submit(Command{}) {
		t.Fatal("queue was not full")
	}
	if !a.Leave(p.Observer) {
		t.Fatal("full combat queue rejected leave")
	}
	unblock.Do(func() { close(release) })
	q := player(140, 112)
	q.ID = "bob"
	q.Observer = "socket-b"
	deadline := time.Now().Add(time.Second)
	for !a.Submit(Command{Player: &q}) {
		if time.Now().After(deadline) {
			t.Fatal("room stopped on leave")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-observed:
	case <-time.After(time.Second):
		t.Fatal("other player could not join")
	}
	select {
	case <-a.Done():
		t.Fatal("leave stopped whole room")
	default:
	}
}
