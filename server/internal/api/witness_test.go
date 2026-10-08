package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/coder/websocket"
)

// Legacy JSON client view, independent of the generated payload.
type witnessMessage struct {
	Type      string `json:"type"`
	Beat      string `json:"beat"`
	AccountID string `json:"accountId"`
	Name      string `json:"name"`
}

type witnessed struct {
	Type, Beat, AccountID, Name string
}

func (w *wsClient) witness() witnessed {
	w.t.Helper()
	e := w.expect("witness")
	var m witnessed
	if err := json.Unmarshal([]byte(e.Raw), &m); err != nil {
		w.t.Fatal(err)
	}
	return m
}

func (x *rig) quest(c *http.Cookie, s *response, to, area string) {
	x.t.Helper()
	doc := s.State
	doc.Area = area
	if to == "guardian-defeated" {
		s.Snapshot = x.expect("POST", "/api/story/mark", body(*s, "quest-defeat-mark", map[string]any{"mark": "defeated:stone-warden", "where": testWhere(doc)}), c, 200).Snapshot
	}
	out := x.expect("POST", "/api/quest/step", body(*s, to, map[string]any{"quest": "lantern-road", "to": to, "where": testWhere(doc)}), c, 200)
	s.Snapshot = out.Snapshot
}

func TestWitnessRelayedFromTheBeatToThoseNearby(t *testing.T) {
	x := newRig(t)
	ts := startPresence(t, x, presenceTestConfig())
	x.hero("olive", "Olive", "p1")
	oc, o := x.ready("olive")
	x.seedOpeningDone(o.AccountID)
	x.hero("bob", "Bob", "p1")
	bc, b := x.ready("bob")
	x.hero("cal", "Cal", "p1")
	cc, cs := x.ready("cal")
	x.hero("eve", "Eve", "p1")
	ec, es := x.ready("eve")
	// Dee stands on the same spot of her own world's ruin.
	x.hero("dee", "Dee", "")
	dc, ds := x.ready("dee")
	if b.WorldID != o.WorldID || ds.WorldID == o.WorldID {
		t.Fatal("setup")
	}

	olive := wsConnect(t, ts, oc, o.Lease)
	olive.join("ruin")
	bob := wsConnect(t, ts, bc, b.Lease)
	bob.join("ruin")
	olive.expect("join")
	cal := wsConnect(t, ts, cc, cs.Lease)
	cal.join("ruin")
	olive.expect("join")
	bob.expect("join")
	eve := wsConnect(t, ts, ec, es.Lease)
	eve.join("woodland")
	dee := wsConnect(t, ts, dc, ds.Lease)
	dee.join("ruin")
	stand := func(w *wsClient, x float64, others ...*wsClient) {
		t.Helper()
		w.send(positionMessage(x))
		for _, o := range others {
			o.expect("pos")
		}
	}
	stand(olive, 100, bob, cal)
	stand(bob, 100+float64(WitnessTiles*wildsTileSize)-1, olive, cal)  // just inside
	stand(cal, 100+float64(WitnessTiles*wildsTileSize)+40, olive, bob) // too far
	stand(dee, 100)
	stand(eve, 100)

	// Olive speaks the naming in the ruin: Bob was there; Cal stood too far
	// off, Eve was in the woods, and Dee's ruin is another world's.
	doc := o.State
	x.quest(oc, &o, "accepted", "village")
	doc.Area, doc.Quest = "ruin", "clue-found"
	x.quest(oc, &o, doc.Quest, doc.Area)
	bob.none()
	doc.Quest = "guardian-defeated"
	x.quest(oc, &o, doc.Quest, doc.Area)
	if m := bob.witness(); m.Beat != "warden" || m.AccountID != x.account("olive") || m.Name != "Olive" {
		t.Fatal("witness", m)
	}
	for _, w := range []*wsClient{olive, cal, dee, eve} {
		w.none()
	}
	// Only once: the same progress again records nothing new.
	x.quest(oc, &o, doc.Quest, doc.Area)
	bob.none()
	// The witness's own story doesn't move.
	if s := x.expect("GET", "/api/state", nil, bc, 200); s.State.Quest != b.State.Quest {
		t.Fatal("witness's quest moved", s.State.Quest)
	}
	// The last lantern, the same way.
	doc.Quest = "lantern-lit"
	x.quest(oc, &o, doc.Quest, doc.Area)
	if m := bob.witness(); m.Beat != "lantern" || m.AccountID != x.account("olive") {
		t.Fatal("lantern", m)
	}
	cal.none()

	// No client can send one: the hub refuses the message outright.
	bob.send(map[string]any{"type": "witness", "beat": "warden", "accountId": x.account("bob"), "name": "Bob"})
	bob.closeStatus(websocket.StatusPolicyViolation)
	olive.none()
}

func TestWitnessEchoAndOnlyLiveMoments(t *testing.T) {
	x := newRig(t)
	ts := startPresence(t, x, presenceTestConfig())
	x.hero("olive", "Olive", "p1")
	oc, o := x.ready("olive")
	x.hero("bob", "Bob", "p1")
	bc, b := x.ready("bob")
	bob := wsConnect(t, ts, bc, b.Lease)
	bob.join("wilds:inner-1:0:0")
	bob.send(positionMessage(100))

	// No live doer: the after-commit relay records no witness.
	x.api.presenceWitness(o.WorldID, o.AccountID, o.DisplayName, "wilds:inner-1", "echo:hollis")
	bob.none()
	olive := wsConnect(t, ts, oc, o.Lease)
	olive.join("wilds:inner-1:0:0")
	bob.expect("join")
	olive.send(positionMessage(110))
	bob.expect("pos")
	x.api.presenceWitness(o.WorldID, o.AccountID, o.DisplayName, "wilds:inner-1", "echo:nan")
	if m := bob.witness(); m.Beat != "echo:nan" || m.AccountID != o.AccountID {
		t.Fatal(m)
	}
	recorded := x.expect("GET", "/api/state", nil, bc, 200)
	if recorded.Version != b.Version+1 || len(recorded.State.Flags) != 1 || !strings.HasPrefix(recorded.State.Flags[0], "witness:echo-nan:") {
		t.Fatal("witness not durably recorded", recorded)
	}
	x.api.presenceWitness(o.WorldID, o.AccountID, "Renamed", "wilds:inner-1", "echo:nan")
	bob.none()
	x.api.presenceWitness(o.WorldID, o.AccountID, o.DisplayName, "wilds:outer-1", "echo:tam")
	bob.none()
	if got := x.expect("GET", "/api/state", nil, bc, 200); got.Version != recorded.Version {
		t.Fatal("repeat bumped witness")
	}
	// A sixth traveler of the same beat gets no row or version bump.
	for i := 0; i < 4; i++ {
		mark := fmt.Sprintf("witness:echo-nan:earlier-%d:Earlier", i)
		if _, err := x.db.DB.Exec("INSERT INTO story_marks VALUES(?,?,'server',?)", x.account("bob"), mark, x.now.Load()); err != nil {
			t.Fatal(err)
		}
	}
	if n := count(t, x.db, "SELECT count(*) FROM story_marks WHERE account_id=? AND mark LIKE 'witness:echo-nan:%'", x.account("bob")); n != 5 {
		t.Fatal("seeded cap", n, b.AccountID, x.account("bob"))
	}
	x.stand("sixth", o.WorldID, "wilds:inner-1:0:0", 110, 20)
	defer x.stand("sixth", o.WorldID, "", 0, 0)
	for i := 0; i < 5; i++ {
		if _, err := x.db.DB.Exec("INSERT INTO story_marks VALUES(?,?,'server',?)", x.account("olive"), fmt.Sprintf("witness:echo-nan:earlier-%d:Earlier", i), x.now.Load()); err != nil {
			t.Fatal(err)
		}
	}
	x.api.presenceWitness(o.WorldID, "sixth", "Sixth", "wilds:inner-1", "echo:nan")
	bob.none()
	if got := x.expect("GET", "/api/state", nil, bc, 200); got.Version != recorded.Version || len(got.State.Flags) != 5 {
		t.Fatal("witness cap", got)
	}
	olive.none()
}
