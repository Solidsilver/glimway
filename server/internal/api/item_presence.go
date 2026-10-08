package api

import (
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v2"
)

// ------------------------------------------------------------ presence

// together: both players are connected in this world, in the same room, and
// stood within radius px of each other when they last moved.
func (h *presenceHub) together(world, a, b string, radius float64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	p, q := h.peers[a], h.peers[b]
	if p == nil || q == nil || p.detached || q.detached || p.identity.World != world || q.identity.World != world || p.area == "" || p.area != q.area || p.pos == nil || q.pos == nil {
		return false
	}
	dx, dy := p.pos.X-q.pos.X, p.pos.Y-q.pos.Y
	return dx*dx+dy*dy <= radius*radius
}

// presenceGift tells the recipient, if connected, what was handed to them.
func (a *Server) presenceGift(world, to, fromName string, v content.Asset) {
	h := a.presence
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	p := h.peers[to]
	if p == nil || p.identity.World != world || p.queue == nil {
		return
	}
	h.send(p, &contract.PresenceGift{FromName: capDonor(fromName), Kind: v.Kind, ItemDef: v.ID, Qty: int32(v.Qty)})
}
