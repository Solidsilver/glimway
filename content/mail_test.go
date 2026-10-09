package content

import "testing"

func TestMailLoaderVectors(t *testing.T) {
	var vectors struct {
		Loader []loaderVector
	}
	readVectors(t, "mail", &vectors)
	base, _ := FS.ReadFile("mail.json")
	for _, v := range vectors.Loader {
		t.Run("loader/"+v.Name, func(t *testing.T) {
			_, err := DecodeMail(editVector(t, base, v))
			if (err == nil) != v.Valid {
				t.Fatal(v.Valid, err)
			}
			if !v.Valid && v.Rule != "" {
				checkVectorRule(t, err, v.Rule)
			}
		})
	}
}
