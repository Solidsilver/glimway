package main

import (
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"regexp"
	"strings"
)

// Only Vite's content-hashed top-level assets are immutable. The committed
// runtime art has stable names and must revalidate after an update.
var hashedAsset = regexp.MustCompile(`^/assets/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9.]+$`)

// withStatic leaves the API unchanged and optionally serves the web bundle.
// os.Root prevents even symlinks in the bundle from escaping the public root.
func withStatic(backend http.Handler, directory string) (http.Handler, func(), error) {
	if directory == "" {
		return backend, func() {}, nil
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, nil, fmt.Errorf("open static directory: %w", err)
	}
	index, err := root.Open("index.html")
	if err == nil {
		var info os.FileInfo
		info, err = index.Stat()
		if err == nil && !info.Mode().IsRegular() {
			err = fmt.Errorf("index.html is not a regular file")
		}
		index.Close()
	}
	if err != nil {
		root.Close()
		return nil, nil, fmt.Errorf("open static index: %w", err)
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/ws" || strings.HasPrefix(r.URL.Path, "/ws/") {
			backend.ServeHTTP(w, r)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/")
		for _, segment := range strings.Split(name, "/") {
			if strings.HasPrefix(segment, ".") || strings.Contains(segment, `\`) {
				http.NotFound(w, r)
				return
			}
		}
		if name == "" {
			name = "index.html"
		}
		file, err := root.Open(name)
		// SPA fallback is only for navigation paths, never missing assets or
		// reserved API/socket routes. Do not expose directory listings.
		accept := r.Header.Get("Accept")
		if os.IsNotExist(err) && path.Ext(name) == "" && !strings.HasPrefix(name, "assets/") &&
			(accept == "" || accept == "*/*" || strings.Contains(accept, "text/html")) {
			name = "index.html"
			file, err = root.Open(name)
		}
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		// Pages and version.json (the client's "new version" check) are never
		// cached: either one stale would hide a release.
		if !strings.HasSuffix(name, ".html") && name != "version.json" {
			w.Header().Set("Cache-Control", "public, max-age=0, must-revalidate")
			if hashedAsset.MatchString("/" + name) {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
		}
		// A content ETag keeps stable-name art correct even when reproducible
		// builds give successive releases the same modification timestamp.
		hash := sha256.New()
		if _, err := io.Copy(hash, file); err != nil {
			http.Error(w, "read failed", http.StatusInternalServerError)
			return
		}
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			http.Error(w, "read failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("ETag", fmt.Sprintf("\"%x\"", hash.Sum(nil)))
		http.ServeContent(w, r, name, info.ModTime(), file)
	})
	return handler, func() { root.Close() }, nil
}
