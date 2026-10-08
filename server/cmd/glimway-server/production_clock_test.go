//go:build !dev

package main

import (
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A production build has no -dev-clock flag and no clock route: the request
// reaches the API as any unknown path would.
func TestProductionBuildHasNoDevClock(t *testing.T) {
	f := flag.NewFlagSet("test", flag.ContinueOnError)
	f.SetOutput(io.Discard)
	start := devClock(f)
	if err := f.Parse([]string{"-dev-clock=100"}); err == nil {
		t.Fatal("-dev-clock parsed in a production build")
	}
	c, err := start()
	if err != nil {
		t.Fatal(err)
	}
	if d := time.Since(c.now()); d < 0 || d > time.Second {
		t.Fatal("not the real clock", d)
	}
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	r := httptest.NewRequest(http.MethodPost, "/api/dev/clock", strings.NewReader(`{"advance_seconds": 60}`))
	r.RemoteAddr = "127.0.0.1:5000"
	w := httptest.NewRecorder()
	c.mount(inner).ServeHTTP(w, r)
	if w.Code != http.StatusTeapot {
		t.Fatal("the dev clock route answered in a production build:", w.Code)
	}
	if err := run([]string{"-dev-clock=100"}); err == nil || !strings.Contains(err.Error(), "dev-clock") {
		t.Fatal("run accepted -dev-clock:", err)
	}
}
