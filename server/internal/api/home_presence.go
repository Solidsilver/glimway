package api

import (
	"fmt"
	contract "glimway/server/internal/gen/glimway/v2"
	"strings"
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
		if p.identity.World == world && ((p.area == "outdoors" || strings.HasPrefix(p.area, "outdoors:")) || p.area == fmt.Sprintf("in:home:%d", gate)) {
			h.enqueue(p, b)
		}
	}
}
