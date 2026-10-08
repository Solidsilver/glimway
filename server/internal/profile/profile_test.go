package profile

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNoneNeedsNoHabiticaRow(t *testing.T) {
	p, err := For(context.Background(), nil, Account{ID: "guest", Source: "none"})
	if err != nil || p != nil || EarnsXP("none") || !EarnsXP("habitica") {
		t.Fatal(p, err)
	}
	if _, err = For(context.Background(), nil, Account{Source: "unknown"}); err == nil {
		t.Fatal("unknown profile source accepted")
	}
}
func TestAccountReadersUseProfileBoundary(t *testing.T) {
	root := ".."
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "gen" || d.Name() == "migrations" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") || strings.Contains(path, "migration_") || strings.Contains(path, "/profile/") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.Contains(line, "SELECT") && strings.Contains(line, "profile_json") {
				t.Errorf("mapped profile reader outside seam: %s", path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
