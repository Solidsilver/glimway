package settings

import (
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite deploy/glimway.example.toml")

const examplePath = "../../../deploy/glimway.example.toml"

func noEnv(string) (string, bool) { return "", false }

func envOf(vars map[string]string) Lookup {
	return func(name string) (string, bool) { v, ok := vars[name]; return v, ok }
}

// The example file is Example(): every setting, from Settings' tags.
func TestExampleFileIsCurrent(t *testing.T) {
	want := Example()
	if *update {
		if err := os.WriteFile(examplePath, []byte(want), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile(examplePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Fatal("deploy/glimway.example.toml is stale: go test ./server/internal/settings -run TestExample -update")
	}
}

// Uncommenting every setting in the example gives a file that parses to the
// defaults, and names every setting.
func TestExampleUncommentedIsTheDefaults(t *testing.T) {
	text := regexp.MustCompile(`(?m)^# ([a-z_]+ = )`).ReplaceAllString(Example(), "$1")
	s, err := Parse([]byte(text))
	if err != nil {
		t.Fatal(err)
	}
	if s.Tools() != Default().Tools() {
		t.Fatal("dev tools differ from the defaults", s.Tools())
	}
	s.Server.Dev, s.Web.Dev = ServerDev{}, WebDev{}
	if !reflect.DeepEqual(s, Default()) {
		t.Fatalf("example settings %+v, defaults %+v", s, Default())
	}
	if n := len(regexp.MustCompile(`(?m)^[a-z_]+ = `).FindAllString(text, -1)); n != len(Fields()) {
		t.Fatal("example has", n, "settings, Settings", len(Fields()))
	}
}

// Every key says when it applies and what it is; every table what it's for.
func TestEveryFieldIsDescribed(t *testing.T) {
	var walk func(rt reflect.Type)
	walk = func(rt reflect.Type) {
		for i := range rt.NumField() {
			f := rt.Field(i)
			if f.Tag.Get("toml") == "" || f.Tag.Get("doc") == "" {
				t.Fatal("no toml or doc tag:", rt.Name(), f.Name)
			}
			if isTable(f.Type) {
				walk(f.Type)
			} else if a := f.Tag.Get("apply"); a != "live" && a != "restart" {
				t.Fatalf("%s.%s: apply must be live or restart, is %q", rt.Name(), f.Name, a)
			}
		}
	}
	walk(reflect.TypeFor[Settings]())
}

func TestUnknownKeysAreRefused(t *testing.T) {
	for _, text := range []string{"[dev]\nenabel = true\n", "[devv]\nenable = true\n", "port = 1\n", "[server.dev]\nhooks = true\n"} {
		if _, err := Parse([]byte(text)); err == nil || !strings.Contains(err.Error(), "unknown setting") {
			t.Fatalf("%q: %v", text, err)
		}
	}
	if _, err := Parse([]byte("[dev]\nenable = \"yes\"\n")); err == nil {
		t.Fatal("a string took a bool's place")
	}
}

func TestEmptyFileIsTheDefaults(t *testing.T) {
	s, err := Parse(nil)
	if err != nil || !reflect.DeepEqual(s, Default()) {
		t.Fatal(s, err)
	}
}

// Defaults, then the file, then the environment (flags: the server command).
func TestLayers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte("[server.login]\nrate = 7\nconcurrency = 2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := Load(path, envOf(map[string]string{"SERVER_LOGIN_CONCURRENCY": "3", "LOGIN_GLOBAL_RATE": "9"}), false)
	if err != nil {
		t.Fatal(err)
	}
	if l := s.Server.Login; l.Rate != 7 || l.Concurrency != 3 || l.GlobalRate != 9 {
		t.Fatal(l)
	}
	// The new name wins over the old.
	s, err = Load("", envOf(map[string]string{"SERVER_LOGIN_RATE": "5", "LOGIN_RATE": "6"}), false)
	if err != nil || s.Server.Login.Rate != 5 {
		t.Fatal(s.Server.Login, err)
	}
	s, err = Load("", envOf(map[string]string{"DEV_ENABLE": "true", "DEV_ACCOUNTS": " 0f9d6d9e-7c55-4b8e-9d3a-2a1c3b4d5e6f , ", "SERVER_DEV_CLOCK": "false"}), true)
	if err != nil || !s.Dev.Enable || len(s.Dev.Accounts) != 1 || s.Tools().Clock || !s.Tools().Grant {
		t.Fatal(s, err)
	}
	if _, err = Load("", envOf(map[string]string{"LOGIN_RATE": "x"}), false); err == nil || !strings.Contains(err.Error(), "GLIMWAY_LOGIN_RATE") {
		t.Fatal(err)
	}
	if _, err = Load("", envOf(map[string]string{"LOGIN_RATE": "0"}), false); err == nil {
		t.Fatal("a zero rate passed")
	}
}

func TestToolsFollowEnableAndTheAccounts(t *testing.T) {
	s, err := Parse([]byte("[dev]\nenable = true\n[server.dev]\nclock = false\n"))
	if err != nil {
		t.Fatal(err)
	}
	if got := s.ToolsFor("anyone"); got != (Tools{Grant: true, Hooks: true, FightFall: true}) {
		t.Fatal(got)
	}
	off := false
	if (Settings{Server: Server{Dev: ServerDev{Grant: &off}}}).Tools().Any() {
		t.Fatal("tools on with dev mode off")
	}
	const id = "0f9d6d9e-7c55-4b8e-9d3a-2a1c3b4d5e6f"
	s.Dev.Accounts = []string{id}
	if !s.ToolsFor(strings.ToUpper(id)).Grant || s.ToolsFor("1f9d6d9e-7c55-4b8e-9d3a-2a1c3b4d5e6f").Any() {
		t.Fatal("accounts list not applied")
	}
}

func TestWebFor(t *testing.T) {
	s := Default()
	if got := s.WebFor(Tools{}); !reflect.DeepEqual(got, map[string]any{"dev": nil}) {
		t.Fatal(got)
	}
	if got := s.WebFor(Tools{Hooks: true}); got["dev"] != (Tools{Hooks: true}) {
		t.Fatal(got)
	}
}

func TestCheck(t *testing.T) {
	on := Default()
	on.Dev.Enable = true
	if err := on.Check(false); err == nil || !strings.Contains(err.Error(), "dev build") {
		t.Fatal("a release build took dev mode:", err)
	}
	if err := on.Check(true); err != nil {
		t.Fatal(err)
	}
	bad := Default()
	bad.Dev.Accounts = []string{"@someone"}
	if bad.Check(true) == nil {
		t.Fatal("a non-id account passed")
	}
}

// A reload takes the live settings and keeps the startup ones, naming them.
func TestReloadKeepsStartupSettings(t *testing.T) {
	running := Default()
	loaded := Default()
	loaded.Dev.Enable = true
	loaded.Dev.Accounts = []string{"a"}
	loaded.Server.Login.Rate = 99
	next, pending := Reload(running, loaded)
	if !next.Dev.Enable || len(next.Dev.Accounts) != 1 {
		t.Fatal("live settings not taken", next.Dev)
	}
	if next.Server.Login.Rate != 10 {
		t.Fatal("a startup setting changed on reload")
	}
	if !reflect.DeepEqual(pending, []string{"server.login.rate"}) {
		t.Fatal(pending)
	}
	if running.Dev.Enable {
		t.Fatal("reload changed the running value in place")
	}
}

func TestEnvNames(t *testing.T) {
	var names []string
	for _, f := range Fields() {
		names = append(names, f.EnvName())
	}
	want := []string{"DEV_ENABLE", "DEV_ACCOUNTS", "SERVER_LOGIN_CONCURRENCY", "SERVER_LOGIN_RATE", "SERVER_LOGIN_GLOBAL_RATE", "SERVER_DEV_GRANT", "SERVER_DEV_CLOCK", "SERVER_DEV_FIGHT_FALL", "WEB_DEV_HOOKS"}
	if !reflect.DeepEqual(names, want) {
		t.Fatal(names)
	}
	_ = noEnv
}

// Under NixOS a settings change only reloads, unless the module restarts for
// it: every restart-only setting's table must be in its restartTriggers.
func TestNixRestartsForRestartSettings(t *testing.T) {
	nix, err := os.ReadFile("../../../deploy/nixos/instance.nix")
	if err != nil {
		t.Fatal(err)
	}
	line := regexp.MustCompile(`(?m)^\s*restartTriggers = .*$`).Find(nix)
	for _, f := range Fields() {
		if table := "cfg.settings." + strings.Join(f.Path[:len(f.Path)-1], "."); !f.Live && !strings.Contains(string(line), table) {
			t.Errorf("%s is restart-only, but deploy/nixos/instance.nix's restartTriggers lacks %s", f.Name(), table)
		}
	}
}
