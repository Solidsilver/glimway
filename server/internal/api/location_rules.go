package api

import (
	"glimway/server/internal/location"
	"glimway/server/internal/store"
)

// generatedPlace gates epoch-bound operations; fixed outdoor ground has no rewards or fallen lanterns.
func generatedPlace(area string, x, y float64) bool {
	return area == string(location.Outdoors) && location.At(location.Space(area), x, y).Source.Kind == location.SourceGenerated
}

func placeID(s store.Snapshot) string {
	return location.At(location.Space(s.State.Area), s.State.Position.X, s.State.Position.Y).ID
}

// contentTile bridges the separate Commons scene until S5 joins it to outdoors.
func contentTile(current, area string, tx, ty int) (string, int, int) {
	if current == area {
		return area, tx, ty
	}
	space, x, y := location.Resolve(area, tx, ty)
	return string(space), x, y
}
