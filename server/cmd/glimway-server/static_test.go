package main

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStaticServing(t *testing.T) {
	dir := t.TempDir()
	for name, data := range map[string]string{
		"index.html":                     "<html>Glimway</html>",
		"assets/index-aB123456.js":       "console.log('game')",
		"assets/fingersnap/terrain.webp": "runtime art",
		"version.json":                   `{"version":"0.1.0","build":"abc1234"}`,
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
		{"GET", "/version.json", 200, `{"version":"0.1.0","build":"abc1234"}`, "no-store"},
		{"HEAD", "/version.json", 200, "", "no-store"},
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

// The static-only mode (serve-static, the NixOS web unit): what a returning
// player's browser sees for each kind of file, and that changed art is
// downloaded again rather than kept.
func TestStaticOnlyCaching(t *testing.T) {
	dir := t.TempDir()
	write := func(name, data string) {
		file := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
			t.Fatal(err)
		}
		// Replace, as a deploy does: a new file, not an edit in place.
		tmp := file + ".tmp"
		if err := os.WriteFile(tmp, []byte(data), 0644); err != nil {
			t.Fatal(err)
		}
		// The Nix store's timestamp, the same for every release.
		stamp := time.Unix(1, 0)
		if err := os.Chtimes(tmp, stamp, stamp); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(tmp, file); err != nil {
			t.Fatal(err)
		}
	}
	write("index.html", "<html>Glimway</html>")
	write("version.json", `{"version":"0.13.0","build":"abc1234"}`)
	write("assets/index-aB123456.js", "console.log('game')")
	write("assets/fingersnap/runtime-pass/manifest.json", `{"art":1}`)
	handler, closeHandler, err := staticOnly(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer closeHandler()
	get := func(path string, header ...string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest("GET", path, nil)
		for i := 0; i+1 < len(header); i += 2 {
			r.Header.Set(header[i], header[i+1])
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	sum := func(data string) string { return fmt.Sprintf("\"%x\"", sha256.Sum256([]byte(data))) }

	const art = "/assets/fingersnap/runtime-pass/manifest.json"
	w := get(art)
	if w.Code != 200 || w.Body.String() != `{"art":1}` {
		t.Fatalf("art: %d %q", w.Code, w.Body.String())
	}
	if got := w.Header().Get("Cache-Control"); got != "public, max-age=0, must-revalidate" {
		t.Fatalf("art cache %q", got)
	}
	etag := w.Header().Get("ETag")
	if etag != sum(`{"art":1}`) {
		t.Fatalf("art etag %q", etag)
	}
	// The 1970 timestamp is no validator: none sent, and none honoured.
	if lm := w.Header().Get("Last-Modified"); lm != "" {
		t.Fatalf("Last-Modified %q", lm)
	}
	if w = get(art, "If-Modified-Since", "Thu, 01 Jan 1970 00:00:01 GMT"); w.Code != 200 {
		t.Fatalf("If-Modified-Since alone: %d", w.Code)
	}

	// A repeat launch: the browser revalidates and keeps its copy.
	w = get(art, "If-None-Match", etag)
	if w.Code != http.StatusNotModified || w.Body.Len() != 0 {
		t.Fatalf("revalidate: %d %q", w.Code, w.Body.String())
	}
	if w.Header().Get("ETag") != etag || w.Header().Get("Cache-Control") != "public, max-age=0, must-revalidate" {
		t.Fatalf("304 headers %v", w.Header())
	}

	// A release changes the art under the same name and timestamp: the old
	// ETag no longer matches, so the player downloads the new file.
	write("assets/fingersnap/runtime-pass/manifest.json", `{"art":2}`)
	w = get(art, "If-None-Match", etag)
	if w.Code != 200 || w.Body.String() != `{"art":2}` || w.Header().Get("ETag") != sum(`{"art":2}`) {
		t.Fatalf("changed art: %d %q %q", w.Code, w.Body.String(), w.Header().Get("ETag"))
	}

	w = get("/assets/index-aB123456.js")
	if w.Code != 200 || w.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" || w.Header().Get("ETag") == "" {
		t.Fatalf("hashed asset: %d %v", w.Code, w.Header())
	}
	for _, path := range []string{"/", "/index.html", "/world/friends", "/version.json"} {
		w = get(path, "Accept", "text/html")
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: %d %q", path, w.Code, w.Header().Get("Cache-Control"))
		}
	}
	// No game behind it: the proxy sends these to the backend instead.
	for _, path := range []string{"/api/session", "/ws"} {
		if w = get(path); w.Code != 404 {
			t.Fatalf("%s: %d", path, w.Code)
		}
	}
}

func TestServeStaticCommand(t *testing.T) {
	if err := run([]string{"serve-static"}); err == nil || !strings.Contains(err.Error(), "usage") {
		t.Fatalf("serve-static without -static-dir: %v", err)
	}
	if err := run([]string{"-static-dir", t.TempDir(), "serve-static"}); err == nil || !strings.Contains(err.Error(), "index") {
		t.Fatalf("serve-static without index.html: %v", err)
	}
}
