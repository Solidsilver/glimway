package api

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/coder/websocket"
	contract "glimway/server/internal/gen/glimway/v2"
	"google.golang.org/protobuf/proto"
)

// Server frames (presence v3): a writer puts whatever is queued when it
// wakes into one PresenceFrame, assembled by prefixing the shared event
// bytes, capped so no frame is larger than max(presenceFrameBytes, one event).

func frameEvents(t *testing.T, events ...proto.Message) [][]byte {
	t.Helper()
	out := make([][]byte, 0, len(events))
	for _, e := range events {
		b, err := encodePresence(e)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, b)
	}
	return out
}
func queued(events ...[]byte) chan []byte {
	q := make(chan []byte, len(events)+1)
	for _, e := range events {
		q <- e
	}
	return q
}

// The prefix assembly is the protobuf PresenceFrame, byte for byte, and
// splitting it gives the events back in order.
func TestPresenceFrameAssemblyIsTheProtobuf(t *testing.T) {
	events := frameEvents(t, &contract.PresenceReady{AccountId: "alice"}, &contract.PresenceLeave{AccountId: "bob"}, &contract.PresenceEmote{Id: "wave", AccountId: proto.String("carol")})
	var frame []byte
	for _, e := range events {
		frame = appendPresenceEvent(frame, e)
	}
	var decoded contract.PresenceFrame
	if err := proto.Unmarshal(frame, &decoded); err != nil {
		t.Fatal(err)
	}
	want := &contract.PresenceFrame{}
	for _, e := range events {
		var m contract.PresenceMessage
		if err := proto.Unmarshal(e, &m); err != nil {
			t.Fatal(err)
		}
		want.Events = append(want.Events, &m)
	}
	if !proto.Equal(&decoded, want) {
		t.Fatal("assembled frame differs from the protobuf")
	}
	if encoded, err := proto.Marshal(want); err != nil || !bytes.Equal(encoded, frame) {
		t.Fatalf("assembled bytes differ from proto.Marshal: %x vs %x (%v)", frame, encoded, err)
	}
	split, err := splitPresenceFrame(frame)
	if err != nil || len(split) != len(events) {
		t.Fatal("split", err, len(split))
	}
	for i := range events {
		if !bytes.Equal(split[i], events[i]) {
			t.Fatalf("event %d out of order or altered", i)
		}
	}
	if _, err := splitPresenceFrame([]byte{0x12, 0x00}); err == nil {
		t.Fatal("a frame with a field other than events must not split")
	}
	if _, err := splitPresenceFrame([]byte{0x0a, 0x05, 0x01}); err == nil {
		t.Fatal("a truncated frame must not split")
	}
}

// A writer wake-up drains what is queued, in order, into one frame; a lone
// event is sent as it is; the drained count is what queuedBytes gives back.
func TestPresenceFrameDrainsTheQueueInOrder(t *testing.T) {
	events := frameEvents(t, &contract.PresenceReady{AccountId: "alice"}, &contract.PresenceLeave{AccountId: "bob"}, &contract.PresenceLeave{AccountId: "carol"})
	q := queued(events[1], events[2])
	frame, carry, drained := fillPresenceFrame(nil, events[0], q)
	if carry != nil || drained != len(events[0])+len(events[1])+len(events[2]) || len(q) != 0 {
		t.Fatal("drain", carry, drained, len(q))
	}
	split, _ := splitPresenceFrame(frame)
	if len(split) != 3 || !bytes.Equal(split[0], events[0]) || !bytes.Equal(split[1], events[1]) || !bytes.Equal(split[2], events[2]) {
		t.Fatal("frame order")
	}
	frame, carry, drained = fillPresenceFrame(frame, events[0], q)
	split, _ = splitPresenceFrame(frame)
	if carry != nil || drained != len(events[0]) || len(split) != 1 {
		t.Fatal("a lone event goes alone", carry, drained, len(split))
	}
}

// The cap: an event is added only while the frame stays within
// presenceFrameBytes; the first one that would not fit starts the next
// frame (carried, never dropped or reordered), and a lone event may exceed
// the cap on its own, so a frame is never larger than 128 KB.
func TestPresenceFrameCap(t *testing.T) {
	big := func(n int) []byte {
		b, err := encodePresence(&contract.PresenceGift{FromName: string(bytes.Repeat([]byte("g"), n))})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	// Exactly at the cap: two events whose frame is presenceFrameBytes long fit.
	a := big(presenceFrameBytes/2 - 20)
	fill := presenceFrameBytes - presenceEventSize(a) - presenceEventSize(big(0))
	b := big(fill)
	for len(appendPresenceEvent(appendPresenceEvent(nil, a), b)) < presenceFrameBytes {
		fill++
		b = big(fill)
	}
	for len(appendPresenceEvent(appendPresenceEvent(nil, a), b)) > presenceFrameBytes {
		fill--
		b = big(fill)
	}
	c := big(10)
	q := queued(b, c)
	frame, carry, drained := fillPresenceFrame(nil, a, q)
	if len(frame) != presenceFrameBytes || !bytes.Equal(carry, c) || drained != len(a)+len(b) {
		t.Fatalf("at the cap: frame %d carry %v drained %d", len(frame), carry != nil, drained)
	}
	// One byte over: the second event is carried.
	q = queued(big(fill + 1))
	frame, carry, drained = fillPresenceFrame(nil, a, q)
	if len(frame) != presenceEventSize(a) || carry == nil || drained != len(a) {
		t.Fatal("one over the cap must carry", len(frame), carry != nil, drained)
	}
	// The carried event starts the next frame and nothing is lost.
	frame, carry2, _ := fillPresenceFrame(frame, carry, q)
	if split, _ := splitPresenceFrame(frame); carry2 != nil || len(split) != 1 || !bytes.Equal(split[0], carry) {
		t.Fatal("carry starts the next frame")
	}
	// A lone event past the cap (enqueue allows up to 128 KB) goes alone.
	lone := big(100000)
	q = queued(c)
	frame, carry, _ = fillPresenceFrame(nil, lone, q)
	if len(frame) != presenceEventSize(lone) || !bytes.Equal(carry, c) {
		t.Fatal("a lone event past the cap goes alone and the next is carried")
	}
}

// Golden frames for the client (tests/proto-contract.test.ts): one lone
// event and one batch, as hex. UPDATE_PROTO_FIXTURES=1 rewrites the file.
func TestPresenceFrameGolden(t *testing.T) {
	path := "testdata/presence-frame.json"
	type golden struct {
		Events    []json.RawMessage `json:"events"`
		BinaryHex string            `json:"binaryHex"`
	}
	frames := [][]proto.Message{
		{&contract.PresenceReady{AccountId: "alice"}},
		{&contract.PresenceRoom{Area: "village", Players: []*contract.PresencePlayer{}}, &contract.PresencePosition{AccountId: proto.String("bob"), X: proto.Float64(10), Y: proto.Float64(20), Facing: &contract.PresenceFacing{X: proto.Float64(0), Y: proto.Float64(1)}, Moving: proto.Bool(true)}, &contract.PresenceLeave{AccountId: "carol"}},
	}
	var want []golden
	for _, events := range frames {
		g := golden{}
		var frame []byte
		for _, e := range frameEvents(t, events...) {
			frame = appendPresenceEvent(frame, e)
			var m contract.PresenceMessage
			if err := proto.Unmarshal(e, &m); err != nil {
				t.Fatal(err)
			}
			flat, err := presenceFixtureJSON(&m)
			if err != nil {
				t.Fatal(err)
			}
			g.Events = append(g.Events, flat)
		}
		g.BinaryHex = hex.EncodeToString(frame)
		want = append(want, g)
	}
	raw, _ := json.MarshalIndent(want, "", "  ")
	raw = append(raw, '\n')
	if os.Getenv("UPDATE_PROTO_FIXTURES") == "1" {
		if err := os.WriteFile(path, raw, 0644); err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got, expected any
	json.Unmarshal(b, &got)
	json.Unmarshal(raw, &expected)
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("%s is stale: UPDATE_PROTO_FIXTURES=1 rewrites it", path)
	}
}

// On the socket: events queued before the writer wakes share one frame,
// in queue order. A socket that opens inside its predecessor's leave grace
// inherits the area, so its ready and its roster are queued together at
// registration and arrive in one frame.
func TestPresenceSocketBatchesQueuedEvents(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	ts := startPresence(t, x, presenceTestConfig())
	w := wsBinaryConnect(t, ts, c, s.Lease)
	w.join("village")
	conn, _, err := dialPresence(t, ts, c, ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	conn.SetReadLimit(131072)
	auth, err := encodePresence(&contract.PresenceAuth{Lease: s.Lease})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageBinary, auth); err != nil {
		t.Fatal(err)
	}
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	events, err := splitPresenceFrame(data)
	if err != nil {
		t.Fatal(err)
	}
	var types []string
	for _, raw := range events {
		m, err := decodePresence(raw)
		if err != nil {
			t.Fatal(err)
		}
		switch {
		case m.GetReady() != nil:
			types = append(types, "ready")
		case m.GetRoom() != nil:
			types = append(types, "room")
		default:
			types = append(types, "other")
		}
	}
	if !reflect.DeepEqual(types, []string{"ready", "room"}) {
		t.Fatalf("first frame carries ready then room: %v", types)
	}
	w.closeStatus(presenceReplaced)
}
