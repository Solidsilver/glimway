package api

import (
	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/location"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
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
