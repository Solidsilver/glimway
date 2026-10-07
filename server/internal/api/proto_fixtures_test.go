package api

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

type calendarFixture struct {
	Unix int64           `json:"unix"`
	Body json.RawMessage `json:"body"`
}

// Captured from the original HTTP handler before migrating its response type.
func TestCalendarGolden(t *testing.T) {
	x := newRig(t)
	path := "testdata/calendar.json"
	var fixtures []calendarFixture

	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(b, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		x.api.Config.Now = func() time.Time { return time.Unix(f.Unix, 0) }
		w := httptest.NewRecorder()
		x.api.ServeHTTP(w, httptest.NewRequest("GET", "/api/calendar", nil))
		var got, want any
		if err = json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if err = json.Unmarshal(f.Body, &want); err != nil {
			t.Fatal(err)
		}
		gb, _ := json.Marshal(got)
		wb, _ := json.Marshal(want)
		if w.Code != 200 || string(gb) != string(wb) {
			t.Fatalf("unix %d: got %s want %s", f.Unix, gb, wb)
		}
	}
}

func TestErrorGolden(t *testing.T) {
	b, err := os.ReadFile("testdata/errors.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err = json.Unmarshal(b, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		w := httptest.NewRecorder()
		problem(w, fail(409, f.Error.Code))
		var got any
		if err = json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		want := map[string]any{"error": map[string]any{"code": f.Error.Code}}
		gb, _ := json.Marshal(got)
		wb, _ := json.Marshal(want)
		if w.Code != 409 || string(gb) != string(wb) {
			t.Fatalf("code %s: got %s want %s", f.Error.Code, gb, wb)
		}
	}
}
