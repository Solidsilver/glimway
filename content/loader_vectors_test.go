package content

import "testing"

// runLoaderVectors edits the shipped family file by the shared vectors
// (content/vectors/<vectors>.json) and decodes with `decode`, asserting each
// refusal names its rule — the same file the TypeScript tests replay.
func runLoaderVectors(t *testing.T, file, vectors string, decode func(raw []byte) (any, error)) {
	t.Helper()
	var vectorDoc struct {
		Loader []loaderVector
	}
	readVectors(t, vectors, &vectorDoc)
	base, err := FS.ReadFile(file + ".json")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range vectorDoc.Loader {
		t.Run("loader/"+v.Name, func(t *testing.T) {
			_, err := decode(editVector(t, base, v))
			if (err == nil) != v.Valid {
				t.Fatal(v.Valid, err)
			}
			if !v.Valid && v.Rule != "" {
				checkVectorRule(t, err, v.Rule)
			}
		})
	}
}
