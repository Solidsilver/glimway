package content

import (
	"testing"
)

func TestPresenceContent(t *testing.T) {
	p := PresenceRules
	if p.GetPositionHz() != 8 || len(p.GetEmotes()) != 5 || p.GetMaxConnections() != 128 || p.GetMessageBytes() != 1024 {
		t.Fatal("presence defaults")
	}
	if p.GetMaxSessionConnections() != 2 || p.GetMaxPlayerConnections() != 4 || p.GetRevalidateFailures() != 3 || p.GetIncomingMessagesPerSecond() != 30 || p.GetIncomingBurst() != 60 || p.GetIncomingExcessMs() != 5000 {
		t.Fatal("presence abuse defaults")
	}
}

// The shared vectors (content/vectors/presence.json) mutate the shipped
// file and both runtimes must refuse each malformation for its rule.
func TestPresenceLoaderVectors(t *testing.T) {
	var vectors struct {
		Loader []loaderVector
	}
	readVectors(t, "presence", &vectors)
	if len(vectors.Loader) == 0 {
		t.Fatal("no presence vectors")
	}
	raw, err := FS.ReadFile("presence.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors.Loader {
		t.Run(v.Name, func(t *testing.T) {
			_, err := DecodePresence(editVector(t, raw, v))
			if (err == nil) != v.Valid {
				t.Fatal(v.Valid, err)
			}
			if !v.Valid && v.Rule != "" {
				checkVectorRule(t, err, v.Rule)
			}
		})
	}
}

// Loader vectors for the other five small families: the shipped file and
// mutations of it, each refusal naming its rule.
func TestFamilyLoaderVectors(t *testing.T) {
	for family, decode := range map[string]func([]byte) error{
		"contract": func(raw []byte) error { _, err := DecodeContract(raw); return err },
		"vitals":   func(raw []byte) error { _, err := DecodeVitals(raw); return err },
		"combat":   func(raw []byte) error { _, err := DecodeCombat(raw); return err },
		"papers":   func(raw []byte) error { _, err := DecodePapers(raw); return err },
		"story":    func(raw []byte) error { _, err := DecodeStory(raw); return err },
	} {
		var vectors struct {
			Loader []loaderVector
		}
		readVectors(t, family, &vectors)
		if len(vectors.Loader) == 0 {
			t.Fatal("no loader vectors for " + family)
		}
		raw, err := FS.ReadFile(family + ".json")
		if err != nil {
			t.Fatal(err)
		}
		for _, v := range vectors.Loader {
			t.Run(family+"/"+v.Name, func(t *testing.T) {
				err := decode(editVector(t, raw, v))
				if (err == nil) != v.Valid {
					t.Fatal(v.Valid, err)
				}
				if !v.Valid && v.Rule != "" {
					checkVectorRule(t, err, v.Rule)
				}
			})
		}
	}
}
