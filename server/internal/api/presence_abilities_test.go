package api

import (
	"encoding/json"
	"glimway/content"
	"glimway/server/internal/rules"
	"math"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

// The hub's PresenceAbility relay and ward credit (docs/design/crafts.md
// 4.5), driven through the real socket and the real report.

type abilityEvent struct {
	Type      string  `json:"type"`
	Ability   string  `json:"ability"`
	AccountID string  `json:"accountId"`
	X, Y      float64 `json:"x"`
}

func (w *wsClient) expectAbility() abilityEvent {
	w.t.Helper()
	e := w.expect("ability")
	var out abilityEvent
	if err := json.Unmarshal([]byte(e.Raw), &out); err != nil {
		w.t.Fatal(err)
	}
	return out
}

func castMessage(id string, x, y float64) map[string]any {
	return map[string]any{"type": "ability", "ability": id, "x": x, "y": y}
}

func position(x, y float64) map[string]any {
	return map[string]any{"type": "pos", "x": x, "y": y, "facing": map[string]any{"x": 0, "y": 1}, "moving": false}
}

// playResponse resumes the tab's lease (the same client id keeps it).
func (x *rig) playResponse(c *http.Cookie) *contract.PlayResponse {
	x.t.Helper()
	w := x.rawHTTP("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c)
	var p contract.PlayResponse
	if e := protojson.Unmarshal(w.Body.Bytes(), &p); e != nil {
		x.t.Fatal(e)
	}
	return &p
}

func TestPresenceAbilityRelayAndCooldown(t *testing.T) {
	x := newRig(t)
	p := profile("alice", 20, 0, 20)
	class := "mage"
	p.Class = &class
	x.set(p)
	c, s := x.ready("alice")
	bc, bs := x.member("bob", s.WorldID)
	ts := startPresence(t, x, presenceTestConfig())
	alice := wsConnect(t, ts, c, s.Lease)
	alice.join("village")
	bob := wsConnect(t, ts, bc, bs.Lease)
	bob.join("village")
	alice.expect("join")

	// Signatures relay too (lane F sends every cast), account_id filled in.
	alice.send(castMessage("fingersnap", 100, 200))
	got := bob.expectAbility()
	if got.Ability != "fingersnap" || got.AccountID != x.account("alice") {
		t.Fatal("signature relay", got)
	}
	// The table's cooldown holds the next one back; nothing else is sent.
	alice.send(castMessage("fingersnap", 100, 200))
	bob.none()
	time.Sleep(1100 * time.Millisecond)
	alice.send(castMessage("fingersnap", 100, 200))
	if bob.expectAbility().Ability != "fingersnap" {
		t.Fatal("no relay past the cooldown")
	}
	// The level-20 move relays at level 20; a cast never closes a socket.
	alice.send(castMessage("kindle", 120, 200))
	if bob.expectAbility().Ability != "kindle" {
		t.Fatal("move relay")
	}
	// An unknown move, another class's move and one beyond the level mark
	// are dropped.
	alice.send(castMessage("fireball", 100, 200))
	alice.send(castMessage("ward-light", 100, 200))
	alice.send(castMessage("ward-light", 100, 200))
	bob.none()
	// A hero with no craft casts nothing.
	bob.send(castMessage("mend", 100, 200))
	bob.none()
	// A client may not name who cast.
	bob.send(map[string]any{"type": "ability", "ability": "mend", "x": 0, "y": 0, "accountId": "mallory"})
	bob.closeStatus(websocket.StatusPolicyViolation)
}

func TestPresenceWardCreditHealsAFriend(t *testing.T) {
	x := newRig(t)
	healer := profile("alice", 20, 0, 20)
	class := "healer"
	healer.Class = &class
	x.set(healer)
	c, s := x.ready("alice")
	bc, bs := x.member("bob", s.WorldID)
	cc, cs := x.member("carol", s.WorldID)
	ts := startPresence(t, x, presenceTestConfig())
	alice := wsConnect(t, ts, c, s.Lease)
	alice.join("village")
	bob := wsConnect(t, ts, bc, bs.Lease)
	bob.join("village")
	alice.expect("join")
	carol := wsConnect(t, ts, cc, cs.Lease)
	carol.join("village")
	alice.expect("join")
	bob.expect("join")
	carol.send(position(500, 500))
	alice.expect("pos")
	bob.expect("pos")
	// Bob stands at (320, 320) and then says nothing more: an idle hero's
	// last position is what the hub keeps.
	bob.send(position(320, 320))
	alice.expect("pos")
	carol.expect("pos")

	ward := mustAbility(t, "ward-light")
	pulse := rules.WardPulseHeal(&healer, ward)
	oneWard := rules.WardHeal(&healer, ward)
	alicePlay, bobPlay, carolPlay := x.playResponse(c), x.playResponse(bc), x.playResponse(cc)

	// A ward at Bob's feet relays to the room, and its pulses credit him.
	alice.send(castMessage("ward-light", 320, 320))
	if bob.expectAbility().Ability != "ward-light" || carol.expectAbility().Ability != "ward-light" {
		t.Fatal("ward relay")
	}
	time.Sleep(4200 * time.Millisecond)
	healed := x.abilityReport(bc, bobPlay, 1, bobPlay.State.Version, 30, 50, 0, nil)
	if math.Abs(healed.GetReport().AllyHeal-oneWard) > 1e-9 {
		t.Fatal("ward credit", healed.GetReport().AllyHeal, oneWard, pulse)
	}
	if healed.State.Vitals.Hp != 30 {
		t.Fatal("credit refused the rise", healed.State.Vitals.Hp)
	}
	// The credit is used up by that report: the next one has none.
	next := x.abilityReport(bc, bobPlay, 2, healed.State.Version, 40, 50, 0, nil)
	if next.GetReport().AllyHeal != 0 || next.State.Vitals.Hp != 30 {
		t.Fatal("credit reused", next.GetReport().AllyHeal, next.State.Vitals.Hp)
	}
	// Carol stood outside the circle: drawn, but mended nobody out there.
	outside := x.abilityReport(cc, carolPlay, 1, carolPlay.State.Version, 40, 50, 0, nil)
	if outside.GetReport().AllyHeal != 0 || outside.State.Vitals.Hp != 20 {
		t.Fatal("a ward reached outside its circle", outside.GetReport().AllyHeal, outside.State.Vitals.Hp)
	}
	// The caster's own heal comes with their report, never as credit.
	mine := x.abilityReport(c, alicePlay, 1, alicePlay.State.Version, 50, 50, 0, map[string]float64{"ward-light": 1})
	if mine.GetReport().AllyHeal != 0 {
		t.Fatal("the caster was credited", mine.GetReport().GetAllyHeal())
	}

	// The hub's checks refresh with the account's state (revalidateMs).
	if _, err := x.db.DB.Exec("UPDATE sync_baselines SET verified_high_level=2 WHERE account_id=?", x.account("alice")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		x.api.presence.mu.Lock()
		magic := x.api.presence.peers[x.account("alice")].identity.Magic
		x.api.presence.mu.Unlock()
		if magic.LevelMark == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the hub kept stale marks", magic)
		}
		time.Sleep(20 * time.Millisecond)
	}
	// Mend (level 10) is now beyond Alice's mark: dropped, socket intact.
	alice.send(castMessage("mend", 320, 320))
	bob.none()
}

func TestWardPulseScheduleMatchesTheTable(t *testing.T) {
	ward := mustAbility(t, "ward-light")
	if len(wardPulseOffsets) != int(ward.GetNumbers().GetPulses()) {
		t.Fatal("pulse schedule", wardPulseOffsets, ward.GetNumbers().GetPulses())
	}
	for i, want := range []time.Duration{time.Second, 2500 * time.Millisecond, 4 * time.Second} {
		if wardPulseOffsets[i] != want {
			t.Fatal("pulse times are 1, 2.5 and 4 s", wardPulseOffsets)
		}
	}
}

func mustAbility(t *testing.T, id string) *content.Ability {
	t.Helper()
	a, ok := content.AbilityFor(id)
	if !ok {
		t.Fatal("missing ability", id)
	}
	return a
}
