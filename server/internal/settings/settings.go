// Package settings is the server's settings file: TOML, named by -config or
// GLIMWAY_CONFIG (docs/design/server-settings.md).
//
// Settings is the one list of them. Each key carries its doc and when a
// change takes effect (`apply:"live"`: on reload, SIGHUP, while players stay
// connected; `apply:"restart"`: at the next start). The layers, lowest first:
// the defaults (Default), the file, GLIMWAY_* variables (Env), then flags (the
// server command's own). The example file (deploy/glimway.example.toml) is
// generated from the tags, and a test keeps it in step.
package settings

import (
	"bytes"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/BurntSushi/toml"
)

// Settings is every setting. A struct field is a table; any other field is a
// key (bool, int, string, []string, or *bool: unset follows dev.enable).
type Settings struct {
	Dev    Dev    `toml:"dev" doc:"Dev mode: who gets the playtesting tools ([server.dev] and [web.dev] list them). Needs a dev build (go build -tags dev); a release build refuses to start with enable = true."`
	Server Server `toml:"server" doc:"The server's own settings."`
	Web    Web    `toml:"web" doc:"The web client's settings: the server hands them to each signed-in player (GET /api/web-settings), so a change needs no new web build."`
}

// Dev is [dev]: whether dev mode is on, and for whom. Both sides read it.
type Dev struct {
	Enable   bool     `toml:"enable" apply:"live" doc:"Turn dev mode on. Every tool in [server.dev] and [web.dev] follows this unless set itself."`
	Accounts []string `toml:"accounts" apply:"live" doc:"Habitica user ids that get the tools. Empty: every signed-in player on this server."`
}

// Server is [server].
type Server struct {
	Login Login     `toml:"login" doc:"Sign-in limits."`
	Dev   ServerDev `toml:"dev" doc:"Dev mode's server tools (routes under /api/dev/)."`
}

// Login is [server.login].
type Login struct {
	Concurrency int `toml:"concurrency" apply:"restart" env:"LOGIN_CONCURRENCY" doc:"Most sign-in proofs at once against Habitica. Flag: -login-concurrency."`
	Rate        int `toml:"rate" apply:"restart" env:"LOGIN_RATE" doc:"Sign-in attempts a minute per IP (or IPv6 /64). Flag: -login-rate."`
	GlobalRate  int `toml:"global_rate" apply:"restart" env:"LOGIN_GLOBAL_RATE" doc:"Most calls to Habitica's sign-in a minute, retries included. Flag: -login-global-rate."`
}

// ServerDev is [server.dev]: nil follows dev.enable.
type ServerDev struct {
	Grant     *bool `toml:"grant" apply:"live" doc:"Grants: glims, materials and items from the dev panel."`
	Clock     *bool `toml:"clock" apply:"live" doc:"Moving the server clock forward. World-wide and forward-only."`
	FightFall *bool `toml:"fight_fall" apply:"live" doc:"Finishing a camp's fight at once."`
	WorldLab  *bool `toml:"world_lab" apply:"live" doc:"The world lab: the Wilds generator drawn from any seed, with edited rules tried in worker processes, and moving your hero to a spot it shows."`
}

// Web is [web]: everything here reaches the client (WebFor).
type Web struct {
	Dev WebDev `toml:"dev" doc:"Dev mode's client tools."`
}

// WebDev is [web.dev]: nil follows dev.enable.
type WebDev struct {
	Hooks *bool `toml:"hooks" apply:"live" doc:"The browser's window.__fs* playtest hooks: warps, reads, console tools."`
}

// Default is the settings with no file, and what a file leaves out.
func Default() Settings {
	return Settings{
		Dev:    Dev{Accounts: []string{}},
		Server: Server{Login: Login{Concurrency: 4, Rate: 10, GlobalRate: 60}},
	}
}

// Tools is what dev mode lets one account use.
type Tools struct {
	Grant     bool `json:"grant"`
	Hooks     bool `json:"hooks"`
	Clock     bool `json:"clock"`
	FightFall bool `json:"fight_fall"`
	WorldLab  bool `json:"world_lab"`
}

// Any: at least one tool is on.
func (t Tools) Any() bool { return t.Grant || t.Hooks || t.Clock || t.FightFall || t.WorldLab }

// Tools is the tools dev mode turns on, before the accounts list.
func (s Settings) Tools() Tools {
	if !s.Dev.Enable {
		return Tools{}
	}
	on := func(v *bool) bool { return v == nil || *v }
	d := s.Server.Dev
	return Tools{Grant: on(d.Grant), Hooks: on(s.Web.Dev.Hooks), Clock: on(d.Clock), FightFall: on(d.FightFall), WorldLab: on(d.WorldLab)}
}

// ToolsFor is the tools one Habitica account gets: none unless the accounts
// list is empty or names it.
func (s Settings) ToolsFor(habiticaID string) Tools {
	if len(s.Dev.Accounts) > 0 && !slices.ContainsFunc(s.Dev.Accounts, func(a string) bool { return strings.EqualFold(a, habiticaID) }) {
		return Tools{}
	}
	return s.Tools()
}

// WebFor is [web] as one player's client reads it: each [web] setting by
// its TOML name, with "dev" replaced by the dev tools this player has (both
// sides', so the panel shows only what the server will do), or null.
func (s Settings) WebFor(tools Tools) map[string]any {
	out := map[string]any{}
	v := reflect.ValueOf(s.Web)
	for i := range v.NumField() {
		if key := v.Type().Field(i).Tag.Get("toml"); key != "dev" {
			out[key] = v.Field(i).Interface()
		}
	}
	out["dev"] = nil
	if tools.Any() {
		out["dev"] = tools
	}
	return out
}

var habiticaID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// Check refuses settings this server can't run: bad values, and dev mode in
// a build without dev tools (devBuild: built with -tags dev).
func (s Settings) Check(devBuild bool) error {
	if s.Dev.Enable && !devBuild {
		return fmt.Errorf("dev.enable = true needs a dev build (go build -tags dev, or a dev package or image); this server is a release build")
	}
	for _, id := range s.Dev.Accounts {
		if !habiticaID.MatchString(id) {
			return fmt.Errorf("dev.accounts: %q is not a Habitica user id (a UUID, from Habitica's Settings > Site Data)", id)
		}
	}
	l := s.Server.Login
	if l.Concurrency < 1 || l.Rate < 1 || l.GlobalRate < 1 {
		return fmt.Errorf("server.login: concurrency, rate and global_rate must be at least 1")
	}
	return nil
}

// Parse reads TOML over the defaults. A key Settings doesn't have is an
// error, so a typo never passes quietly.
func Parse(data []byte) (Settings, error) {
	s := Default()
	md, err := toml.NewDecoder(bytes.NewReader(data)).Decode(&s)
	if err != nil {
		return Settings{}, err
	}
	if extra := md.Undecoded(); len(extra) > 0 {
		keys := make([]string, len(extra))
		for i, k := range extra {
			keys[i] = k.String()
		}
		return Settings{}, fmt.Errorf("unknown setting %s", strings.Join(keys, ", "))
	}
	if s.Dev.Accounts == nil {
		s.Dev.Accounts = []string{}
	}
	return s, nil
}

// Lookup reads one environment variable by its name after GLIMWAY_ (the
// server command also reads the old FINGERSNAP_ names).
type Lookup func(name string) (string, bool)

// Env applies environment overrides: GLIMWAY_ and the key's path in
// capitals (dev.enable: GLIMWAY_DEV_ENABLE; server.login.rate:
// GLIMWAY_SERVER_LOGIN_RATE), or a key's older name (`env` tag:
// GLIMWAY_LOGIN_RATE). Lists are comma-separated.
func (s *Settings) Env(lookup Lookup) error {
	v := reflect.ValueOf(s).Elem()
	for _, f := range Fields() {
		names := []string{f.EnvName()}
		if f.envAlias != "" {
			names = append(names, f.envAlias)
		}
		for _, name := range names {
			raw, ok := lookup(name)
			if !ok || raw == "" {
				continue
			}
			if err := setFromString(v.FieldByIndex(f.index), raw); err != nil {
				return fmt.Errorf("invalid GLIMWAY_%s: %w", name, err)
			}
			break
		}
	}
	return nil
}

func setFromString(v reflect.Value, raw string) error {
	switch {
	case v.Kind() == reflect.Bool, v.Kind() == reflect.Pointer && v.Type().Elem().Kind() == reflect.Bool:
		b, err := strconv.ParseBool(raw)
		if err != nil {
			return err
		}
		if v.Kind() == reflect.Pointer {
			v.Set(reflect.ValueOf(&b))
		} else {
			v.SetBool(b)
		}
	case v.Kind() == reflect.Int:
		n, err := strconv.Atoi(raw)
		if err != nil {
			return err
		}
		v.SetInt(int64(n))
	case v.Kind() == reflect.String:
		v.SetString(raw)
	case v.Kind() == reflect.Slice && v.Type().Elem().Kind() == reflect.String:
		list := []string{}
		for _, part := range strings.Split(raw, ",") {
			if part = strings.TrimSpace(part); part != "" {
				list = append(list, part)
			}
		}
		v.Set(reflect.ValueOf(list))
	default:
		return fmt.Errorf("settings: no environment form for %s", v.Type())
	}
	return nil
}

// Load is the defaults, the file at path (none: "") and the environment,
// checked.
func Load(path string, lookup Lookup, devBuild bool) (Settings, error) {
	s := Default()
	where := "settings"
	if path != "" {
		where = path
		data, err := os.ReadFile(path)
		if err != nil {
			return Settings{}, err
		}
		if s, err = Parse(data); err != nil {
			return Settings{}, fmt.Errorf("%s: %w", path, err)
		}
	}
	err := s.Env(lookup)
	if err == nil {
		err = s.Check(devBuild)
	}
	if err != nil {
		return Settings{}, fmt.Errorf("%s: %w", where, err)
	}
	return s, nil
}

// Field is one key, as Settings' tags describe it.
type Field struct {
	// Path is the key's tables and name: ["server", "login", "rate"].
	Path     []string
	Live     bool
	Doc      string
	envAlias string
	index    []int
}

// Name is the dotted path, server.login.rate.
func (f Field) Name() string { return strings.Join(f.Path, ".") }

// EnvName is the variable after GLIMWAY_: SERVER_LOGIN_RATE.
func (f Field) EnvName() string { return strings.ToUpper(strings.Join(f.Path, "_")) }

// Fields lists every key in Settings' order.
func Fields() []Field {
	var out []Field
	var walk func(t reflect.Type, path []string, index []int)
	walk = func(t reflect.Type, path []string, index []int) {
		for i := range t.NumField() {
			sf := t.Field(i)
			p := append(slices.Clone(path), sf.Tag.Get("toml"))
			ix := append(slices.Clone(index), i)
			if isTable(sf.Type) {
				walk(sf.Type, p, ix)
				continue
			}
			out = append(out, Field{Path: p, Live: sf.Tag.Get("apply") == "live", Doc: sf.Tag.Get("doc"), envAlias: sf.Tag.Get("env"), index: ix})
		}
	}
	walk(reflect.TypeFor[Settings](), nil, nil)
	return out
}

func isTable(t reflect.Type) bool { return t.Kind() == reflect.Struct }

// Reload is what a reload makes of the running settings and freshly loaded
// ones: the new live settings, and the running value of every setting that
// waits for a restart (each named in pending when it differs).
func Reload(running, loaded Settings) (next Settings, pending []string) {
	next = running
	nv, lv, rv := reflect.ValueOf(&next).Elem(), reflect.ValueOf(loaded), reflect.ValueOf(running)
	for _, f := range Fields() {
		from := lv.FieldByIndex(f.index)
		if f.Live {
			nv.FieldByIndex(f.index).Set(from)
		} else if !reflect.DeepEqual(rv.FieldByIndex(f.index).Interface(), from.Interface()) {
			pending = append(pending, f.Name())
		}
	}
	return next, pending
}

// Example is deploy/glimway.example.toml: every setting, commented out at
// its default, with its doc, its variable and when a change takes effect.
func Example() string {
	var b strings.Builder
	b.WriteString(`# Glimway server settings (TOML). Generated from server/internal/settings
# (go test ./server/internal/settings -run TestExample -update); don't edit by hand.
#
# Point the server at this file with -config <path> or GLIMWAY_CONFIG=<path>.
# Each setting is shown at its default. Layers, lowest first: the defaults,
# this file, GLIMWAY_* variables, then flags. A variable or flag pins its
# setting: a reload reads the file again, but the variable still wins.
#
# "live": takes effect on reload (SIGHUP: systemctl reload, docker kill -s HUP),
#         and players stay connected. A file that doesn't parse or check is
#         refused, and the running settings stay.
# "restart": takes effect at the next start.
`)
	defaults := reflect.ValueOf(Default())
	var walk func(t reflect.Type, path []string, index []int)
	walk = func(t reflect.Type, path []string, index []int) {
		var keys, tables []int
		for i := range t.NumField() {
			if isTable(t.Field(i).Type) {
				tables = append(tables, i)
			} else {
				keys = append(keys, i)
			}
		}
		if len(keys) > 0 {
			fmt.Fprintf(&b, "[%s]\n", strings.Join(path, "."))
		}
		for _, i := range keys {
			sf := t.Field(i)
			f := Field{Path: append(slices.Clone(path), sf.Tag.Get("toml")), envAlias: sf.Tag.Get("env")}
			when := "restart"
			if sf.Tag.Get("apply") == "live" {
				when = "live"
			}
			vars := "GLIMWAY_" + f.EnvName()
			if f.envAlias != "" {
				vars += " or GLIMWAY_" + f.envAlias
			}
			fmt.Fprintf(&b, "\n# %s\n# (%s; %s)\n# %s = %s\n", sf.Tag.Get("doc"), when, vars, sf.Tag.Get("toml"), tomlValue(defaults.FieldByIndex(append(slices.Clone(index), i))))
		}
		for _, i := range tables {
			sf := t.Field(i)
			p := append(slices.Clone(path), sf.Tag.Get("toml"))
			fmt.Fprintf(&b, "\n# [%s] %s\n", strings.Join(p, "."), sf.Tag.Get("doc"))
			walk(sf.Type, p, append(slices.Clone(index), i))
		}
	}
	walk(reflect.TypeFor[Settings](), nil, nil)
	return b.String()
}

func tomlValue(v reflect.Value) string {
	if v.Kind() == reflect.Pointer {
		if v.IsNil() {
			// A tool that follows dev.enable: its default is enable's.
			return "false"
		}
		v = v.Elem()
	}
	var buf bytes.Buffer
	if err := toml.NewEncoder(&buf).Encode(map[string]any{"v": v.Interface()}); err != nil {
		panic(err)
	}
	return strings.TrimSpace(strings.TrimPrefix(buf.String(), "v = "))
}
