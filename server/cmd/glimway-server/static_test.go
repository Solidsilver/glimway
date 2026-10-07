package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStaticServing(t *testing.T) {
	dir := t.TempDir()
	for name, data := range map[string]string{
		"index.html":                     "<html>Glimway</html>",
		"assets/index-aB123456.js":       "console.log('game')",
		"assets/fingersnap/terrain.webp": "runtime art",
	} {
		file := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(data), 0644); err != nil {
			t.Fatal(err)
		}
	}
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		w.Write([]byte("backend"))
	})
	handler, closeHandler, err := withStatic(backend, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer closeHandler()
	for _, tc := range []struct {
		method, path string
		status       int
		body, cache  string
	}{
		{"GET", "/", 200, "<html>Glimway</html>", "no-store"},
		{"HEAD", "/", 200, "", "no-store"},
		{"GET", "/world/friends", 200, "<html>Glimway</html>", "no-store"},
		{"GET", "/assets/index-aB123456.js", 200, "console.log('game')", "public, max-age=31536000, immutable"},
		{"GET", "/assets/fingersnap/terrain.webp", 200, "runtime art", "public, max-age=0, must-revalidate"},
		{"GET", "/assets/missing.js", 404, "", "no-store"},
		{"GET", "/assets/missing", 404, "", "no-store"},
		{"GET", "/assets/", 404, "", "no-store"},
		{"GET", "/escape.txt", 404, "", "no-store"},
		{"GET", "/../secret.txt", 404, "", "no-store"},
		{"GET", "/%2e%2e/secret.txt", 404, "", "no-store"},
		{"GET", "/.env", 404, "", "no-store"},
		{"POST", "/", 405, "", "no-store"},
		{"GET", "/api/missing", 418, "backend", ""},
		{"POST", "/api/session", 418, "backend", ""},
		{"GET", "/ws", 418, "backend", ""},
		{"GET", "/ws/missing", 418, "backend", ""},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, nil)
			r.Header.Set("Accept", "text/html")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.status, w.Body.String())
			}
			if tc.status != 404 && w.Body.String() != tc.body {
				t.Fatalf("body %q", w.Body.String())
			}
			if w.Header().Get("Cache-Control") != tc.cache {
				t.Fatalf("cache %q", w.Header().Get("Cache-Control"))
			}
			if strings.Contains(w.Body.String(), "secret") {
				t.Fatal("escaped static root")
			}
		})
	}
}

func TestStaticDisabledAndInvalidRoot(t *testing.T) {
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(418) })
	h, closeHandler, err := withStatic(backend, "")
	if err != nil {
		t.Fatal(err)
	}
	defer closeHandler()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 418 {
		t.Fatal("disabled static handler replaced backend")
	}
	if _, _, err := withStatic(backend, t.TempDir()); err == nil {
		t.Fatal("accepted missing index.html")
	}
}

func TestLoginEnvironmentLimits(t *testing.T) {
	t.Setenv("FINGERSNAP_LOGIN_RATE", "7")
	if v, err := envInt("LOGIN_RATE", 10); err != nil || v != 7 {
		t.Fatal(v, err)
	}
	t.Setenv("GLIMWAY_LOGIN_RATE", "12")
	if v, err := envInt("LOGIN_RATE", 10); err != nil || v != 12 {
		t.Fatal(v, err)
	}
	for _, value := range []string{"0", "-1", "invalid"} {
		t.Setenv("GLIMWAY_LOGIN_RATE", value)
		if err := run([]string{"-db", filepath.Join(t.TempDir(), "game.sqlite"), "allowlist", "list"}); err == nil {
			t.Fatalf("accepted %q", value)
		}
	}
}
