package api

import (
	"context"
	"strconv"
	"testing"

	contract "glimway/server/internal/gen/glimway/v2"
	"google.golang.org/protobuf/proto"
)

// A full default room: one sender and 31 recipients, including queue byte
// accounting and drain. No network latency obscures time under the hub lock.
func BenchmarkPresenceBroadcast(b *testing.B) {
	b.Run("Binary", func(b *testing.B) {
		h := newPresenceHub(nil, nil)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		peers := make([]*presencePeer, 32)
		for i := range peers {
			p := &presencePeer{identity: presenceIdentity{ID: strconv.Itoa(i), World: "world"}, area: "village", ctx: ctx, cancel: cancel, queue: make(chan []byte, 1)}
			peers[i] = p
			h.peers[p.identity.ID] = p
		}
		message := &contract.PresencePosition{AccountId: proto.String("5abfd539-22eb-457f-8e2a-9fb3d66731f1"), X: proto.Float64(432.125), Y: proto.Float64(768.5), Facing: &contract.PresenceFacing{X: proto.Float64(0), Y: proto.Float64(1)}, Moving: proto.Bool(false)}
		b.ReportAllocs()
		b.ResetTimer()
		for b.Loop() {
			h.mu.Lock()
			h.broadcast(peers[0], message)
			for _, p := range peers[1:] {
				<-p.queue
				p.queuedBytes = 0
			}
			h.mu.Unlock()
		}
	})
}
