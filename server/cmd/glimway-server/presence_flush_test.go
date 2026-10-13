package main

import (
	"strings"
	"testing"
)

func TestPresenceFlushCLIValidation(t *testing.T) {
	t.Setenv("GLIMWAY_LOGIN_CONCURRENCY", "4")
	t.Setenv("GLIMWAY_LOGIN_RATE", "10")
	t.Setenv("GLIMWAY_LOGIN_GLOBAL_RATE", "60")
	t.Setenv("GLIMWAY_COOKIE_SECURE", "true")
	t.Setenv("GLIMWAY_PARTY_ADMISSION", "true")
	for _, v := range []string{"-1", "1", "49", "51", "99", "101", "abc"} {
		t.Setenv("GLIMWAY_PRESENCE_FLUSH_MS", v)
		if e := run([]string{"-trusted-proxies", "invalid"}); e == nil || !strings.Contains(e.Error(), "GLIMWAY_PRESENCE_FLUSH_MS") {
			t.Errorf("env %q not rejected: %v", v, e)
		}
	}
	for _, v := range []string{"0", "50", "100"} {
		t.Setenv("GLIMWAY_PRESENCE_FLUSH_MS", v)
		if e := run([]string{"-trusted-proxies", "invalid"}); e == nil || !strings.Contains(e.Error(), "trusted proxy") {
			t.Errorf("env %q rejected or escaped read-only sentinel: %v", v, e)
		}
	}
	t.Setenv("GLIMWAY_PRESENCE_FLUSH_MS", "0")
	for _, v := range []string{"-1", "1", "49", "51", "99", "101", "abc", "0", "50", "100"} {
		e := run([]string{"-presence-flush-ms", v, "-trusted-proxies", "invalid"})
		valid := v == "0" || v == "50" || v == "100"
		if e == nil || (strings.Contains(e.Error(), "trusted proxy") != valid) {
			t.Errorf("flag %q validation mismatch: %v", v, e)
		}
	}
}
