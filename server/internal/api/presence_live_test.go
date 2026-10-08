package api

import (
	"encoding/json"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v2"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Drive the actual reader, room/player builders, broadcasts, gift and witness
// relays and writer. Compare decoded RAW frames, not test-built messages. Both
// proto.Equal and the JSON key comparison detect omitted optional zero/false.
func TestPresenceLiveFixtures(t *testing.T) {
	b, err := os.ReadFile("testdata/presence-live-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures map[string]json.RawMessage
	if err = json.Unmarshal(b, &fixtures); err != nil {
		t.Fatal(err)
	}
	x := newRig(t)
	c, s := x.ready("alice")
	bc, bs := x.member("bob", s.WorldID)
	for name, raw := range fixtures {
		text := strings.ReplaceAll(string(raw), `"alice"`, `"`+x.account("alice")+`"`)
		text = strings.ReplaceAll(text, `"bob"`, `"`+x.account("bob")+`"`)
		fixtures[name] = json.RawMessage(text)
	}
	check := func(name string, event wsEvent) {
		t.Helper()
		var got contract.PresenceMessage
		if err := proto.Unmarshal(event.Binary, &got); err != nil {
			t.Fatal(err)
		}
		var flat map[string]json.RawMessage
		if err := json.Unmarshal(fixtures[name], &flat); err != nil {
			t.Fatal(err)
		}
		var kind string
		json.Unmarshal(flat["type"], &kind)
		delete(flat, "type")
		payload, _ := json.Marshal(flat)
		envelope, _ := json.Marshal(map[string]json.RawMessage{kind: payload})
		var want contract.PresenceMessage
		if err := protojson.Unmarshal(envelope, &want); err != nil {
			t.Fatal(err)
		}
		if !proto.Equal(&got, &want) {
			t.Errorf("%s raw frame: got %v want %v", name, &got, &want)
		}
		decoded, err := presenceFixtureJSON(&got)
		if err != nil {
			t.Fatal(err)
		}
		var gotKeys, wantKeys any
		json.Unmarshal(decoded, &gotKeys)
		json.Unmarshal(fixtures[name], &wantKeys)
		if !reflect.DeepEqual(gotKeys, wantKeys) {
			t.Errorf("%s keys: got %s want %s", name, decoded, fixtures[name])
		}
	}
	cfg := presenceTestConfig()
	ts := startPresence(t, x, cfg)
	alice := wsAuthenticate(t, ts, c, s.Lease)
	check("ready", alice.expect("ready"))
	check("emptyRoom", alice.join("ruin"))
	bob := wsConnect(t, ts, bc, bs.Lease)
	check("populatedRoom", bob.join("ruin"))
	check("join", alice.expect("join"))
	alice.send(map[string]any{"type": "pos", "x": 100.5, "y": 200.25, "facing": map[string]any{"x": 0, "y": 1}, "moving": false})
	check("pos", bob.expect("pos"))
	time.Sleep(millis(cfg.JoinCooldownMs))
	check("positionedRoom", bob.join("ruin"))
	bob.send(map[string]any{"type": "pos", "x": 100.5, "y": 200.25, "facing": map[string]any{"x": 0, "y": 1}, "moving": false})
	alice.expect("pos") // establishes witness proximity through the real reader
	alice.send(map[string]any{"type": "emote", "id": "wave"})
	check("emote", bob.expect("emote"))
	x.api.presenceGift(s.WorldID, x.account("bob"), "Hero", content.Asset{Kind: "item", ID: "timber", Qty: 1})
	check("gift", bob.expect("gift"))
	x.api.presenceWitness(s.WorldID, x.account("alice"), "Hero", "ruin", "warden")
	check("witness", bob.expect("witness"))
	time.Sleep(millis(cfg.JoinCooldownMs))
	alice.join("woodland")
	check("leave", bob.expect("leave"))
}
