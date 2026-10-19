package main

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
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
	var etags etagCache
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
		// builds give successive releases the same modification timestamp
		// (the Nix store's is 1970), so the timestamp is never a validator:
		// no Last-Modified, and If-Modified-Since can't answer 304.
		etag, err := etags.get(name, info, file)
		if err != nil {
			http.Error(w, "read failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("ETag", etag)
		http.ServeContent(w, r, name, time.Time{}, file)
	})
	return handler, func() { root.Close() }, nil
}

// etagCache hashes each file once rather than on every request. An entry
// is for one file as it was (size, timestamp, inode): a file replaced in
// place under a mutable root is hashed again.
type etagCache struct{ m sync.Map }

type etagKey struct {
	name  string
	size  int64
	mtime int64
	inode uint64
}

func (c *etagCache) get(name string, info os.FileInfo, file io.ReadSeeker) (string, error) {
	key := etagKey{name, info.Size(), info.ModTime().UnixNano(), fileIdentity(info)}
	if v, ok := c.m.Load(key); ok {
		return v.(string), nil
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	etag := fmt.Sprintf("\"%x\"", hash.Sum(nil))
	c.m.Store(key, etag)
	return etag, nil
}

// staticOnly is the web bundle with no game behind it (serve-static): the
// NixOS module's web unit, behind a proxy that sends /api and /ws to the
// backend itself. Those paths answer 404 here.
func staticOnly(directory string) (http.Handler, func(), error) {
	return withStatic(http.NotFoundHandler(), directory)
}

// serveStatic runs staticOnly on addr until SIGINT or SIGTERM. It opens no
// database and reads no settings.
func serveStatic(addr, directory string) error {
	handler, closeStatic, err := staticOnly(directory)
	if err != nil {
		return err
	}
	defer closeStatic()
	server := &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 60 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 16 << 10}
	stop, done := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer done()
	go func() {
		<-stop.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.New(os.Stdout, "glimway ", log.LstdFlags|log.LUTC).Printf("serving static addr=%s dir=%s version=%s", addr, directory, version)
	if err = server.ListenAndServe(); err == http.ErrServerClosed {
		return nil
	}
	return err
}
