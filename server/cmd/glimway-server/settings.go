package main

import (
	"flag"
	"glimway/server/internal/settings"
	"log"
	"net/http"
	"strings"
	"sync/atomic"
)

// envLookup reads GLIMWAY_<name>, then the old FINGERSNAP_<name> (env).
func envLookup(name string) (string, bool) {
	v := env(name, "")
	return v, v != ""
}

// fromFlags puts each flag given on the command line over its setting: the
// top layer, over defaults, the file and GLIMWAY_* variables.
func fromFlags(f *flag.FlagSet, settingOf map[string]*int) {
	f.Visit(func(fl *flag.Flag) {
		if p, ok := settingOf[fl.Name]; ok {
			*p = fl.Value.(flag.Getter).Get().(int)
		}
	})
}

// liveSettings holds the running settings; a reload swaps them whole.
type liveSettings struct {
	path string
	cur  atomic.Pointer[settings.Settings]
}

func (l *liveSettings) get() settings.Settings { return *l.cur.Load() }

// reload reads the settings again (SIGHUP) and takes the live ones. Settings
// that don't load or check change nothing; a setting that waits for a
// restart keeps its running value, and the log says so. (Flags set only
// restart settings, so the running values already carry them.)
func (l *liveSettings) reload(logger *log.Logger) {
	if l.path == "" {
		logger.Printf("settings reload: no settings file (-config, GLIMWAY_CONFIG); nothing to reload")
		return
	}
	loaded, err := settings.Load(l.path, envLookup, devBuild)
	if err != nil {
		logger.Printf("settings reload refused, running settings kept: %v", err)
		return
	}
	next, pending := settings.Reload(l.get(), loaded)
	l.cur.Store(&next)
	logger.Printf("settings reloaded path=%s dev=%t", l.path, next.Dev.Enable)
	if len(pending) > 0 {
		logger.Printf("settings: %s change at the next restart", strings.Join(pending, ", "))
	}
}

// webSettings is GET /api/web-settings' answer: [web] for this caller, with
// the dev tools the caller has (none in a release build: no caller), and the
// clock only when it is movable.
func webSettings(live *liveSettings, caller devCaller, movable bool) func(*http.Request) any {
	return func(r *http.Request) any {
		var tools settings.Tools
		if caller != nil {
			tools = caller(r)
			tools.Clock = tools.Clock && movable
		}
		return live.get().WebFor(tools)
	}
}
