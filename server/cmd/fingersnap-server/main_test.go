package main

import (
	"errors"
	"fingersnap/server/internal/store"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestAdminCommands(t *testing.T) {
	path := filepath.Join(t.TempDir(), "game.sqlite")
	for _, cmd := range [][]string{{"allowlist", "add", "alice"}, {"allowlist", "list"}, {"invite"}, {"flagged"}, {"notes"}, {"backup", filepath.Join(t.TempDir(), "backup.sqlite")}, {"allowlist", "remove", "alice"}} {
		args := append([]string{"-db", path}, cmd...)
		if err := run(args); err != nil {
			t.Fatalf("%v: %v", cmd, err)
		}
	}
	s, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var n int
	if err = s.DB.QueryRow("SELECT count(*) FROM allowlist").Scan(&n); err != nil || n != 0 {
		t.Fatal("allowlist remove")
	}
	for _, cmd := range [][]string{{"backup"}, {"invite", "a", "b"}, {"allowlist", "invalid"}, {"flagged", "extra"}, {"no-command"}} {
		if err = run(append([]string{"-db", path}, cmd...)); err == nil {
			t.Fatalf("accepted invalid CLI %v", cmd)
		}
	}
}

func TestServerSourcesAreNotGitIgnored(t *testing.T) {
	b, err := os.ReadFile("../../../.gitignore")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.TrimSpace(line) == "fingersnap-server" {
			t.Fatal("binary ignore also excludes server sources")
		}
	}
	for _, name := range []string{"main.go", "main_test.go"} {
		path := "server/cmd/fingersnap-server/" + name
		if _, err = os.Stat("../../../" + path); err != nil {
			t.Fatal(err)
		}
		// A Nix source snapshot has no .git and needs no Git executable.
		if _, err = os.Stat("../../../.git"); os.IsNotExist(err) {
			continue
		}
		cmd := exec.Command("git", "check-ignore", "--no-index", path)
		cmd.Dir = "../../.."
		err = cmd.Run()
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 1 {
			t.Fatalf("server source ignored: %s (%v)", path, err)
		}
	}
}
func TestNixUsesEnvCGO(t *testing.T) {
	b, err := os.ReadFile("../../../deploy/nixos/fingersnap-server.nix")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "env.CGO_ENABLED = 0;") {
		t.Fatal("CGO attribute must be in env for buildGoModule")
	}
}
