package main

import (
	"flag"
	"glimway/server/internal/settings"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Defaults, then the file, then GLIMWAY_* (and the old FINGERSNAP_*), then flags.
func TestSettingsLayers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("[server.login]\nrate = 7\nconcurrency = 2\nglobal_rate = 30\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	resolve := func(args ...string) settings.Login {
		t.Helper()
		conf, err := settings.Load(path, envLookup, devBuild)
		if err != nil {
			t.Fatal(err)
		}
		f := flag.NewFlagSet("test", flag.ContinueOnError)
		f.Int("login-rate", 10, "")
		if err := f.Parse(args); err != nil {
			t.Fatal(err)
		}
		fromFlags(f, map[string]*int{"login-rate": &conf.Server.Login.Rate})
		return conf.Server.Login
	}
	if got := resolve(); got.Rate != 7 || got.Concurrency != 2 {
		t.Fatal("the file lost to the defaults:", got)
	}
	t.Setenv("FINGERSNAP_LOGIN_CONCURRENCY", "3")
	t.Setenv("GLIMWAY_LOGIN_RATE", "5")
	t.Setenv("GLIMWAY_SERVER_LOGIN_GLOBAL_RATE", "40")
	if got := resolve(); got.Rate != 5 || got.Concurrency != 3 || got.GlobalRate != 40 {
		t.Fatal("the environment lost to the file:", got)
	}
	if got := resolve("-login-rate=4"); got.Rate != 4 {
		t.Fatal("the flag lost:", got)
	}
}

func TestLoginEnvironmentLimits(t *testing.T) {
	for _, value := range []string{"0", "-1", "invalid"} {
		t.Setenv("GLIMWAY_LOGIN_RATE", value)
		if err := run([]string{"-db", filepath.Join(t.TempDir(), "game.sqlite"), "allowlist", "list"}); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
	t.Setenv("GLIMWAY_LOGIN_RATE", "")
	if err := run([]string{"-db", filepath.Join(t.TempDir(), "game.sqlite"), "-login-rate=0", "allowlist", "list"}); err == nil {
		t.Fatal("accepted -login-rate=0")
	}
}

func TestCheckConfig(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.toml")
	bad := filepath.Join(dir, "bad.toml")
	if err := os.WriteFile(good, []byte("[server.login]\nrate = 3\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bad, []byte("[server.login]\nrat = 3\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"-config", good, "check-config"}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"-config", bad, "check-config"}); err == nil || !strings.Contains(err.Error(), "unknown setting server.login.rat") {
		t.Fatal("a typo passed:", err)
	}
	if err := run([]string{"check-config"}); err == nil {
		t.Fatal("check-config without a file passed")
	}
}
