package worldlab

import (
	"cmp"
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"glimway/content"
)

// Prefix is the lab's routes in a dev build's server: GET state, POST
// check, render and tile. The server mounts them behind its dev gate.
const Prefix = "/api/dev/worldlab/"

// Lab's bounds: at most two worker processes at once (a diff's two panels
// count as two), a request waits for one at most waitLimit, and the cache
// keeps the latest answers up to cacheBytes.
const (
	labSlots     = 2
	labWorkers   = 2
	labWait      = 30 * time.Second
	cacheBytes   = 128 << 20
	maxBody      = 512 << 10
	workerLimit  = 60 * time.Second
	labNiceLevel = 15
)

// Here is the caller's own world, for the lab's defaults: its seed and
// the wick season the server is in now.
type Here struct {
	Seed  string `json:"seed"`
	Epoch string `json:"epoch"`
}

// Lab serves the world lab to a dev build's server. Every render and
// inspection runs in a worker process (Worker), whatever its rules: a
// worker is niced, bounded in time and memory, killed when the request is
// abandoned, and never touches the server's own generator. The server
// process only decodes edited rules to report their errors
// (content.DecodeWilds, which reads no globals but the embedded content).
type Lab struct {
	worker Worker
	here   func(*http.Request) (Here, bool)
	slots  chan struct{}
	cache  *cache
	wait   time.Duration
}

// NewLab makes the lab. argv re-executes this server as a worker (its
// entry calls RunWorker); here is the caller's world, if known.
func NewLab(argv []string, here func(*http.Request) (Here, bool)) *Lab {
	return &Lab{
		worker: Worker{Argv: argv, Nice: labNiceLevel, Timeout: workerLimit, Env: []string{"GOMAXPROCS=2", "GOMEMLIMIT=768MiB"}},
		here:   here,
		slots:  make(chan struct{}, labSlots),
		cache:  newCache(cacheBytes),
		wait:   labWait,
	}
}

type labProblem struct {
	Error string `json:"error"`
}

func labError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(labProblem{msg})
}

func (l *Lab) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	name := strings.TrimPrefix(r.URL.Path, Prefix)
	if name == "state" {
		if r.Method != http.MethodGet {
			labError(w, http.StatusMethodNotAllowed, "GET required")
			return
		}
		l.state(w, r)
		return
	}
	if name != "check" && name != "render" && name != "tile" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodPost {
		labError(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	var req labRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			labError(w, http.StatusRequestEntityTooLarge, "request too large: rules up to 512 KiB")
			return
		}
		labError(w, http.StatusBadRequest, "invalid request: "+err.Error())
		return
	}
	switch name {
	case "check":
		if err := checkRules(req.Rules); err != nil {
			labError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeLabJSON(w, map[string]bool{"ok": true})
	case "render":
		l.render(w, r, req)
	case "tile":
		l.tile(w, r, req)
	}
}

// labRequest is a render ({view, seed, epoch, rect, scale, overlays,
// rules}, and b for a diff: B's seed and rules), a tile ({seed, epoch, at,
// rules}) or a check ({rules}). Rules: the wilds rules as JSON text; empty
// is the server's embedded rules.
type labRequest struct {
	View     string  `json:"view"`
	Seed     string  `json:"seed"`
	Epoch    string  `json:"epoch"`
	Rect     [4]int  `json:"rect"`
	Scale    int     `json:"scale"`
	Overlays string  `json:"overlays"`
	Rules    string  `json:"rules"`
	At       *[2]int `json:"at"`
	B        *struct {
		Seed  string `json:"seed"`
		Rules string `json:"rules"`
	} `json:"b"`
}

func embeddedRules() []byte {
	raw, _ := content.FS.ReadFile("wilds.json")
	return raw
}

// checkRules decodes and validates edited rules in this process. Decoding
// is pure: nothing the generator reads changes.
func checkRules(rules string) error {
	if rules == "" {
		return nil
	}
	if _, err := content.DecodeWilds([]byte(rules)); err != nil {
		return errors.New("rules: " + err.Error())
	}
	return nil
}

// options is the request's render for the worker; edited rules equal to
// the embedded ones are the embedded ones.
func (req labRequest) options(seed, rules string) Options {
	o := Options{View: req.View, Seed: seed, Epoch: req.Epoch, Rect: req.Rect, Scale: req.Scale, Overlays: req.Overlays, Workers: labWorkers}
	if rules != "" && rules != string(embeddedRules()) {
		o.Raw = []byte(rules)
	}
	return o
}

func (l *Lab) state(w http.ResponseWriter, r *http.Request) {
	raw := embeddedRules()
	sum := sha256.Sum256(raw)
	out := map[string]any{
		"seed": "map", "epoch": DefaultEpoch, "defaultEpoch": DefaultEpoch,
		"overlays":  OverlayNames,
		"chunkSize": content.WildsRules.GetChunkSize(),
		"limits":    map[string]int{"atlasChunks": MaxAtlasChunks, "tiles": MaxTiles, "pixels": MaxPixels, "scale": 8, "coordinate": MaxCoordinate},
		"rules":     string(raw), "rulesSHA256": hex.EncodeToString(sum[:]),
		"here": nil,
	}
	if l.here != nil {
		if h, ok := l.here(r); ok {
			out["here"] = h
			out["seed"], out["epoch"] = h.Seed, h.Epoch
		}
	}
	writeLabJSON(w, out)
}

// run is one worker process, once a slot is free.
func (l *Lab) run(ctx context.Context, o Options) (Result, error) {
	wait, cancel := context.WithTimeout(ctx, l.wait)
	defer cancel()
	select {
	case l.slots <- struct{}{}:
		defer func() { <-l.slots }()
	case <-wait.Done():
		if ctx.Err() != nil {
			return Result{}, ctx.Err()
		}
		return Result{}, errBusy
	}
	return l.worker.Run(ctx, o)
}

var errBusy = errors.New("the lab is busy with other renders; try again in a moment")

func (l *Lab) fail(w http.ResponseWriter, err error) {
	if errors.Is(err, errBusy) {
		labError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	labError(w, http.StatusBadRequest, err.Error())
}

func (l *Lab) render(w http.ResponseWriter, r *http.Request, req labRequest) {
	a := req.options(req.Seed, req.Rules)
	var b *Options
	if req.B != nil {
		bo := req.options(cmp.Or(req.B.Seed, req.Seed), req.B.Rules)
		a.Signatures, bo.Signatures = true, true
		b = &bo
	}
	for _, o := range []*Options{&a, b} {
		if o == nil {
			continue
		}
		if err := Validate(*o); err != nil {
			labError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	for _, rules := range []string{req.Rules, bRules(req)} {
		if err := checkRules(rules); err != nil {
			labError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	key := cacheKey("render", a, b)
	if body, ok := l.cache.get(key); ok {
		w.Header().Set("X-Worldlab-Cache", "hit")
		writeLabBytes(w, body)
		return
	}
	started := time.Now()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	var out Result
	var err error
	if b == nil {
		out, err = l.run(ctx, a)
	} else {
		// Both panels at once, each in its own slot; one failing stops the other.
		var rb Result
		var errB error
		var wg sync.WaitGroup
		wg.Go(func() {
			if rb, errB = l.run(ctx, *b); errB != nil {
				cancel()
			}
		})
		if out, err = l.run(ctx, a); err != nil {
			cancel()
		}
		wg.Wait()
		if err == nil {
			err = errB
		}
		if err == nil {
			var image []byte
			var details DiffStats
			image, details, err = Compare(out, rb, time.Since(started))
			out.PNG, out.Comparison, out.Signatures = image, &details, nil
		}
	}
	if err != nil {
		l.fail(w, err)
		return
	}
	body, err := json.Marshal(out)
	if err != nil {
		labError(w, http.StatusInternalServerError, err.Error())
		return
	}
	l.cache.put(key, body)
	writeLabBytes(w, body)
}

func bRules(req labRequest) string {
	if req.B == nil {
		return ""
	}
	return req.B.Rules
}

func (l *Lab) tile(w http.ResponseWriter, r *http.Request, req labRequest) {
	if req.At == nil {
		labError(w, http.StatusBadRequest, "at: the tile [x, y] to inspect")
		return
	}
	if err := checkRules(req.Rules); err != nil {
		labError(w, http.StatusBadRequest, err.Error())
		return
	}
	req.View, req.Scale, req.Overlays = "chunk", 1, ""
	o := req.options(req.Seed, req.Rules)
	o.Inspect = req.At
	o.Rect = [4]int{0, 0, 0, 0}
	if err := Validate(o); err != nil {
		labError(w, http.StatusBadRequest, err.Error())
		return
	}
	key := cacheKey("tile", o, nil)
	if body, ok := l.cache.get(key); ok {
		writeLabBytes(w, body)
		return
	}
	out, err := l.run(r.Context(), o)
	if err != nil {
		l.fail(w, err)
		return
	}
	body, err := json.Marshal(out.Tile)
	if err != nil {
		labError(w, http.StatusInternalServerError, err.Error())
		return
	}
	l.cache.put(key, body)
	writeLabBytes(w, body)
}

func cacheKey(kind string, a Options, b *Options) string {
	raw, _ := json.Marshal(struct {
		Kind string
		A    Options
		B    *Options
	}{kind, a, b})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

func writeLabJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeLabBytes(w http.ResponseWriter, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(body)
}

// cache keeps the most recent answers, least recently used out first,
// within a byte budget.
type cache struct {
	mu    sync.Mutex
	limit int
	size  int
	order *list.List
	items map[string]*list.Element
}

type cached struct {
	key  string
	body []byte
}

func newCache(limit int) *cache {
	return &cache{limit: limit, order: list.New(), items: map[string]*list.Element{}}
}

func (c *cache) get(key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[key]
	if !ok {
		return nil, false
	}
	c.order.MoveToFront(e)
	return e.Value.(*cached).body, true
}

func (c *cache) put(key string, body []byte) {
	if len(body) > c.limit/4 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if e, ok := c.items[key]; ok {
		c.order.MoveToFront(e)
		return
	}
	c.items[key] = c.order.PushFront(&cached{key, body})
	c.size += len(body)
	for c.size > c.limit {
		last := c.order.Back()
		v := last.Value.(*cached)
		c.order.Remove(last)
		delete(c.items, v.key)
		c.size -= len(v.body)
	}
}
