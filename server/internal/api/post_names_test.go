package api

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSharedPostNameVectors(t *testing.T) {
	b, err := os.ReadFile("../../../content/vectors/post-names.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Label string  `json:"label"`
		Raw   string  `json:"raw"`
		Clean *string `json:"clean"`
	}
	if err := json.Unmarshal(b, &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) == 0 {
		t.Fatal("empty post name vectors")
	}
	for _, v := range vectors {
		t.Run(v.Label, func(t *testing.T) {
			name, ok := cleanPostName(v.Raw)
			if v.Clean == nil {
				if ok || name != "" {
					t.Fatalf("accepted %q as %q", v.Raw, name)
				}
			} else if !ok || name != *v.Clean {
				t.Fatalf("cleanPostName(%q) = %q, %t; want %q", v.Raw, name, ok, *v.Clean)
			}
		})
	}
}
