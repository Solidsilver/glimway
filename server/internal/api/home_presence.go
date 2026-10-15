package api

import (
	"fmt"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v2"
)

// A committed edit invalidates public home reads; clients refresh only attached lots.
func (a *Server) homeChanged(world string, gate int) {
	if gate < 0 || gate >= 8 || world == "" {
		return
	}
	h := a.presence
	h.mu.Lock()
	defer h.mu.Unlock()
	b, err := encodePresence(&contract.PresenceHomeChanged{Gate: uint32(gate)})
	if err != nil {
		return
	}
	for _, p := range h.peers {
		if p.identity.World == world && (hearsLot(p.area, gate) || p.area == fmt.Sprintf("in:home:%d", gate)) {
			h.enqueue(p, b)
		}
	}
}

func hearsLot(area string, gate int) bool {
	var cx, cy int
	if _, err := fmt.Sscanf(area, "outdoors:%d:%d", &cx, &cy); err != nil {
		return false
	}
	ox, oy := chunks.LotOrigin(gate)
	return abs(cx-ox/24) <= 1 && abs(cy-oy/24) <= 1
}
