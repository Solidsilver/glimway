package main

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"glimway/content"
	"glimway/server/internal/worldlab"
)

//go:embed index.html
var page []byte

func serve(addr string, defaults options) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return errors.New("serve requires an explicit loopback address, e.g. 127.0.0.1:8099; use ssh -L for remote access")
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	log.Printf("worldlab at http://%s — no database; Ctrl-C to stop", listener.Addr())
	srv := &http.Server{Handler: handler(defaults), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	return srv.Serve(listener)
}

func handler(defaults options) http.Handler {
	mux := http.NewServeMux()
	slots := make(chan struct{}, 1)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'")
		_, _ = w.Write(page)
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		var raw []byte
		var err error
		if defaults.Content != "" {
			raw, err = os.ReadFile(defaults.Content)
		} else {
			raw, err = content.FS.ReadFile("wilds.json")
		}
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if defaults.CompareContent != "" {
			b, err := os.ReadFile(defaults.CompareContent)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			raw = append(append(raw, 0), b...)
		}
		sum := sha256.Sum256(raw)
		writeJSON(w, map[string]any{"revision": hex.EncodeToString(sum[:]), "seed": defaults.Seed, "epoch": defaults.Epoch, "overlays": defaults.Overlays, "field": defaults.Field, "content": defaults.Content, "compareSeed": defaults.CompareSeed, "compareContent": defaults.CompareContent})
	})
	mux.HandleFunc("/api/hover", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		seed := defaults.Seed
		if v := q.Get("seed"); v != "" {
			seed = v
		}
		coords, err := coordinates(q.Get("at"), 2)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		writeJSON(w, worldlab.InspectHover(seed, coords[0], coords[1]))
	})
	renderRequest := func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			http.Error(w, "GET required", 405)
			return
		}
		o := defaults
		o.View = "atlas"
		o.Scale = 2
		o.Rect = [4]int{-40, -60, 39, 19}
		q := r.URL.Query()
		if v := q.Get("view"); v != "" {
			o.View = v
		}
		if v := q.Get("seed"); v != "" {
			o.Seed = v
		}
		if v := q.Get("epoch"); v != "" {
			o.Epoch = v
		}
		if q.Has("overlays") {
			o.Overlays = q.Get("overlays")
		}
		if q.Has("field") {
			o.Field = q.Get("field")
		}
		if v := q.Get("rect"); v != "" {
			coords, err := coordinates(v, 4)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			copy(o.Rect[:], coords)
		}
		if v := q.Get("scale"); v != "" {
			n, err := strconv.Atoi(v)
			if err != nil {
				http.Error(w, "invalid scale", 400)
				return
			}
			o.Scale = n
		}
		if r.URL.Path == "/api/tile" {
			if q.Get("panel") == "b" {
				if v := q.Get("seed-b"); v != "" {
					o.Seed = v
				}
				if defaults.CompareContent != "" {
					o.Content = defaults.CompareContent
				}
			}
			coords, err := coordinates(q.Get("at"), 2)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			o.Inspect = &[2]int{coords[0], coords[1]}
		}
		if err := validate(o); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		case <-r.Context().Done():
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
		defer cancel()
		o.Signatures = q.Get("compare") == "1" && o.Inspect == nil
		started := time.Now()
		out, err := worker(ctx, o)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if o.Inspect != nil {
			writeJSON(w, out.Tile)
			return
		}
		if o.Signatures {
			bOpts := o
			if v := q.Get("seed-b"); v != "" {
				bOpts.Seed = v
			}
			if defaults.CompareContent != "" {
				bOpts.Content = defaults.CompareContent
			}
			b, err := worker(ctx, bOpts)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			image, details, err := worldlab.Compare(out, b, time.Since(started))
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			out.PNG = image
			out.Comparison = &details
			out.Signatures = nil
		}
		// Encoding PNG + stats together makes an image and its measurements atomic.
		writeJSON(w, out)
	}
	mux.HandleFunc("/api/render", renderRequest)
	mux.HandleFunc("/api/tile", renderRequest)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Prevent a remote web page from driving the local generator via fetch.
		if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host {
			http.Error(w, "cross-origin requests refused", 403)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		mux.ServeHTTP(w, r)
	})
}
func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}
