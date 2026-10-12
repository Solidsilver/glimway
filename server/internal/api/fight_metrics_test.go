package api

import (
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestFightMeasurementsAreBoundedAndIndependentOfGameClock(t *testing.T) {
	a := New(nil, nil, Config{Now: func() time.Time { return time.Unix(0, 0) }})
	for i := 0; i < 3000; i++ {
		a.RecordFightTick(time.Duration(i+1) * time.Microsecond)
	}
	a.RecordFightBytes(100)
	a.RecordFightBytes(-1)
	got := a.FightMeasurements()
	if got.Ticks != 3000 || got.TickSamples != 2048 || got.TickMaxMs != 3 || got.OutboundBytes != 100 || got.ElapsedSeconds < 0 || got.ElapsedSeconds > 5 {
		t.Fatal(got)
	}
	if got.TickP95Ms < 2.89 || got.TickP95Ms > 2.90 {
		t.Fatal("wrong rolling percentile", got.TickP95Ms)
	}
}

func TestWildsTimingHeadersIncludeEarlyErrorsOnlyOnMeasuredRoutes(t *testing.T) {
	a := New(nil, nil, Config{})
	for _, path := range []string{"/api/wilds/near/0/-1", "/api/wilds/claim", "/api/state"} {
		w := httptest.NewRecorder()
		method := "GET"
		if path == "/api/wilds/claim" {
			method = "POST"
		}
		a.ServeHTTP(w, httptest.NewRequest(method, path, nil))
		timing := w.Header().Get("Server-Timing")
		if path == "/api/state" {
			if timing != "" {
				t.Fatal(timing)
			}
			continue
		}
		if !strings.HasPrefix(timing, "app;dur=") {
			t.Fatal("missing timing on error", path, timing)
		}
		n, err := strconv.ParseFloat(strings.TrimPrefix(timing, "app;dur="), 64)
		if err != nil || n < 0 {
			t.Fatal(timing, err)
		}
	}
}
