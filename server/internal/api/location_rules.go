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

// contentTile carries a content tile (area-local: Commons positions in
// Commons layout tiles) into its space; other areas are their own frame.
func contentTile(area string, tx, ty int) (string, int, int) {
	space, x, y := location.Resolve(area, tx, ty)
	return string(space), x, y
}
