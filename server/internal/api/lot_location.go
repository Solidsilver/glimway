package api

import (
	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/location"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"math"
	"strconv"
	"strings"
)

func homeGateAt(s *store.Snapshot) int {
	if s.State.Area == outdoorsArea {
		p := location.At(location.Outdoors, s.State.Position.X, s.State.Position.Y)
		if rest, ok := strings.CutPrefix(p.ID, "lot:"); ok {
			g, err := strconv.Atoi(rest)
			if err == nil && g >= 0 && g < 8 {
				return g
			}
		}
		return -1
	}
	return rules.HomeGate(content.RootArea(s.State.Area))
}
func localHomeTile(s *store.Snapshot, x, y int) (int, int) {
	if s.State.Area == outdoorsArea {
		g := homeGateAt(s)
		if g >= 0 {
			ox, oy := chunks.LotOrigin(g)
			return x - ox, y - oy
		}
	}
	return x, y
}

// onPrivateLot is a service boundary, distinct from the whole-zone identity
// used for world-move arrivals and presence subscriptions.
func onPrivateLot(s *store.Snapshot, gate int) bool {
	if s.State.Area != outdoorsArea || homeGateAt(s) != gate {
		return false
	}
	ox, oy := chunks.LotOrigin(gate)
	return chunks.InsideLot(int(math.Floor(s.State.Position.X/16))-ox, int(math.Floor(s.State.Position.Y/16))-oy, gate)
}
