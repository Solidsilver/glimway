package content

import (
	"testing"
)

func TestWildsLoaderVectors(t *testing.T) {
	var vectors struct {
		Loader []loaderVector
	}
	readVectors(t, "wilds", &vectors)
	base, _ := FS.ReadFile("wilds.json")
	if len(vectors.Loader) == 0 {
		t.Fatal("no loader vectors")
	}
	for _, v := range vectors.Loader {
		t.Run("loader/"+v.Name, func(t *testing.T) {
			_, err := DecodeWilds(editVector(t, base, v))
			if (err == nil) != v.Valid {
				t.Fatal(v.Valid, err)
			}
			if !v.Valid && v.Rule != "" {
				checkVectorRule(t, err, v.Rule)
			}
		})
	}
}
