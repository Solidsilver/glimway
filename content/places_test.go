package content

import "testing"

func TestPlacesLoaderVectors(t *testing.T) {
	runLoaderVectors(t, "places", "places-loader", func(raw []byte) (any, error) { return DecodePlaces(raw) })
}
