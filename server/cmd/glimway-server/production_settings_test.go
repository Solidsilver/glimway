//go:build !dev

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A release build refuses dev mode: at start, at check-config and on reload.
func TestReleaseBuildRefusesDevMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "glimway.toml")
	if err := os.WriteFile(path, []byte("[dev]\nenable = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"-config", path, "check-config"}, {"-config", path, "-db", filepath.Join(t.TempDir(), "db.sqlite"), "-listen", "127.0.0.1:0"}} {
		if err := run(args); err == nil || !strings.Contains(err.Error(), "needs a dev build") {
			t.Fatal(args, err)
		}
	}
}
