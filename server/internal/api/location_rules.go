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

// contentTile maps a content place to its saved space. Tiles are already
// world tiles; they never move by a fixed footprint origin.
func contentTile(area string, tx, ty int) (string, int, int) {
	return string(location.ContentSpace(area)), tx, ty
}
