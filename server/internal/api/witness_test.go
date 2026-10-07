package api

import (
	"encoding/json"
	"glimway/server/internal/rules"
	"net/http"
	"slices"
	"testing"

	"github.com/coder/websocket"
)

// Legacy JSON client view, independent of the generated payload.
type witnessMessage struct {
	Type       string `json:"type"`
	Beat       string `json:"beat"`
	HabiticaID string `json:"habiticaId"`
	Name       string `json:"name"`
}

func TestStoryBeats(t *testing.T) {
	st := func(quest string, flags ...string) rules.State {
		return rules.State{Quest: quest, Flags: flags}
	}
	for _, c := range []struct {
		before, after rules.State
		want          []string
	}{
		{st("clue-found"), st("guardian-defeated"), []string{"warden"}},
		{st("guardian-defeated"), st("guardian-defeated"), []string{}},
		{st("guardian-defeated"), st("lantern-lit"), []string{"lantern"}},
		{st("lantern-lit"), st("complete"), []string{}},
		{st("clue-found"), st("complete"), []string{"warden", "lantern"}},
		{st("complete"), st("complete", "echo:nan", "echo:nan:softened", "echo:stranger"), []string{"echo:nan"}},
		{st("complete", "echo:nan"), st("complete", "echo:nan"), []string{}},
	} {
		if got := storyBeats(c.before, c.after); !slices.Equal(got, c.want) {
			t.Errorf("%v → %v: got %v want %v", c.before, c.after, got, c.want)
		}
	}
}

type witnessed struct {
	Type, Beat, HabiticaID, Name string
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

// upload: the doer's progress lands, standing where doc says.
func (x *rig) upload(c *http.Cookie, s *response, doc rules.State) {
	x.t.Helper()
	r := x.expect("PUT", "/api/progress", mutation(*s, doc), c, 200)
	s.Rev = r.Rev
	s.State = r.State
}

func TestWitnessRelayedFromTheBeatToThoseNearby(t *testing.T) {
	x := newRig(t)
	ts := startPresence(t, x, presenceTestConfig())
	x.hero("olive", "Olive", "p1")
	oc, o := x.ready("olive")
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
	doc.Area, doc.Quest = "ruin", "clue-found"
	x.upload(oc, &o, doc)
	bob.none()
	doc.Quest = "guardian-defeated"
	x.upload(oc, &o, doc)
	if m := bob.witness(); m.Beat != "warden" || m.HabiticaID != "olive" || m.Name != "Olive" {
		t.Fatal("witness", m)
	}
	for _, w := range []*wsClient{olive, cal, dee, eve} {
		w.none()
	}
	// Only once: the same progress again records nothing new.
	x.upload(oc, &o, doc)
	bob.none()
	// The witness's own story doesn't move.
	if s := x.expect("GET", "/api/state", nil, bc, 200); s.State.Quest != b.State.Quest {
		t.Fatal("witness's quest moved", s.State.Quest)
	}
	// The last lantern, the same way.
	doc.Quest = "lantern-lit"
	x.upload(oc, &o, doc)
	if m := bob.witness(); m.Beat != "lantern" || m.HabiticaID != "olive" {
		t.Fatal("lantern", m)
	}
	cal.none()

	// No client can send one: the hub refuses the message outright.
	bob.send(map[string]any{"type": "witness", "beat": "warden", "habiticaId": "bob", "name": "Bob"})
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

	// Olive isn't connected: her settling lands, but it's no one's moment.
	doc := o.State
	doc.Quest, doc.Area = "complete", "wilds"
	doc.Flags = append(doc.Flags, "echo:hollis")
	x.upload(oc, &o, doc)
	bob.none()

	// Connected and standing by Bob: settling an Echo is seen.
	olive := wsConnect(t, ts, oc, o.Lease)
	olive.join("wilds:inner-1:0:0")
	bob.expect("join")
	olive.send(positionMessage(110))
	bob.expect("pos")
	doc.Flags = append(doc.Flags, "echo:nan")
	x.upload(oc, &o, doc)
	if m := bob.witness(); m.Beat != "echo:nan" || m.HabiticaID != "olive" {
		t.Fatal("echo", m)
	}
	// A beat whose place doesn't match where she stands (her save says the
	// ruin, her room is a Wilds chunk) is not relayed.
	doc.Flags = append(doc.Flags, "echo:tam")
	doc.Area = "ruin"
	x.upload(oc, &o, doc)
	bob.none()
	// Nor a stale upload (another device's catching up).
	doc.Area = "wilds"
	doc.Flags = append(doc.Flags, "echo:joss")
	stale := o
	stale.Rev--
	if r := x.expect("PUT", "/api/progress", mutation(stale, doc), oc, 200); r.Status != "stale" {
		t.Fatal("not stale", r.Status)
	}
	bob.none()
	olive.none()
}
