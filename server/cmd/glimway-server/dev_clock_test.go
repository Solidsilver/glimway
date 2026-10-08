//go:build dev

package main

import (
	"flag"
	"strings"
	"testing"
	"time"
)

func TestDevClockAdvancesAndRejectsBadInputAtStartup(t *testing.T) {
	f := flag.NewFlagSet("test", flag.ContinueOnError)
	start := devClock(f)
	if err := f.Parse([]string{"-dev-clock=100"}); err != nil {
		t.Fatal(err)
	}
	now, err := start()
	if err != nil {
		t.Fatal(err)
	}
	first := now()
	time.Sleep(2 * time.Millisecond)
	second := now()
	if first.Unix() != 100 || !second.After(first) {
		t.Fatal(first, second)
	}
	if err = run([]string{"-dev-clock=bad"}); err == nil || !strings.Contains(err.Error(), "invalid dev-clock") {
		t.Fatal(err)
	}
}
