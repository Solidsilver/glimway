package main

import (
	"bytes"
	"glimway/server/internal/api"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAdminListenerRequiresLoopbackAndHasIsolatedMux(t *testing.T) {
	a := api.New(nil, nil, api.Config{})
	for _, addr := range []string{"0.0.0.0:0", ":0", "192.0.2.1:0", "[::]:0", "bad"} {
		if close, err := startAdmin(addr, a, log.New(io.Discard, "", 0)); err == nil {
			close()
			t.Fatal("accepted nonloopback", addr)
		}
	}
	var logs bytes.Buffer
	close, err := startAdmin("127.0.0.1:0", a, log.New(&logs, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	defer close()
	addr := strings.TrimSpace(strings.TrimPrefix(logs.String(), "admin listening addr="))
	for _, path := range []string{"/debug/pprof/", "/debug/fights"} {
		res, err := http.Get("http://" + addr + path)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(res.Body)
		res.Body.Close()
		if err != nil || res.StatusCode != 200 || len(body) == 0 {
			t.Fatal(res.StatusCode, err, string(body))
		}
	}
	// Profiling never appears on the game's mux.
	w := httptest.NewRecorder()
	a.ServeHTTP(w, httptest.NewRequest("GET", "/debug/pprof/", nil))
	res := w.Code
	if res != http.StatusNotFound {
		t.Fatal("public profiling endpoint", res)
	}
	// Shutdown releases the port.
	close()
	if res, err := http.Get("http://" + addr + "/debug/fights"); err == nil {
		res.Body.Close()
		t.Fatal("admin listener still serving after shutdown")
	}
}
