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
	"glimway/server/internal/wilds"
)

//go:embed index.html
var page []byte

type tileInfo struct {
	Tile          [2]int            `json:"tile"`
	Chunk         [2]int            `json:"chunk"`
	Local         [2]int            `json:"local"`
	Epoch         wilds.Epoch       `json:"epoch"`
	Land          string            `json:"land"`
	ChunkLand     string            `json:"chunkLand"`
	Ground        string            `json:"ground"`
	Solid         bool              `json:"solid"`
	Entities      []wilds.Entity    `json:"entitiesOnTile"`
	ChunkEntities []wilds.Entity    `json:"chunkEntities"`
	Sites         []wilds.Site      `json:"sitesOnTile"`
	Places        []wilds.PlaceMark `json:"placesOnTile"`
	Fixed         string            `json:"fixed,omitempty"`
}

func inspect(o options) (result, error) {
	tx, ty := o.Inspect[0], o.Inspect[1]
	cx, cy := wilds.ChunkOf(tx, ty)
	lx, ly := wilds.LocalOf(tx, ty)
	info := &tileInfo{Tile: *o.Inspect, Chunk: [2]int{cx, cy}, Local: [2]int{lx, ly}, Epoch: epoch(o, cx, cy), Entities: []wilds.Entity{}, Sites: []wilds.Site{}, Places: []wilds.PlaceMark{}}
	if p := wilds.FixedFootprintAt(cx, cy); p != nil {
		info.Fixed = p.GetId()
		return result{Tile: info}, nil
	}
	c, err := wilds.GenerateV3(info.Epoch, cx, cy, nil)
	if err != nil {
		return result{}, err
	}
	info.Land = wilds.LandAt(wilds.WickEpoch(o.Seed, o.Epoch), tx, ty)
	info.ChunkLand = c.Land
	info.Ground = content.WildsRules.Grounds[int(c.Ground[ly*c.Size+lx])].GetId()
	info.Solid = c.Solid[ly*c.Size+lx]
	info.ChunkEntities = c.Entities
	for _, e := range c.Entities {
		if e.TX == lx && e.TY == ly {
			info.Entities = append(info.Entities, e)
		}
	}
	for _, s := range c.Sites {
		if s.TX == lx && s.TY == ly {
			info.Sites = append(info.Sites, s)
		}
	}
	for _, p := range c.Places {
		if p.TX == lx && p.TY == ly {
			info.Places = append(info.Places, p)
		}
	}
	return result{Tile: info}, nil
}

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
		writeJSON(w, map[string]any{"revision": hex.EncodeToString(sum[:]), "seed": defaults.Seed, "epoch": defaults.Epoch, "overlays": defaults.Overlays, "content": defaults.Content, "compareSeed": defaults.CompareSeed, "compareContent": defaults.CompareContent})
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
			image, report, err := compare(out, b, time.Since(started))
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			details := report.(diffStats)
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
