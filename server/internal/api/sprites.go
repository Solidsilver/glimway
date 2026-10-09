package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"glimway/content"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Habitica outfit art (playtest 1). The avatar's layers are Habitica's own
// sprites; only a few dozen ship in the bundled cache, and Habitica's sprite
// host sends no CORS headers, so the browser can't use the rest as WebGL
// textures. GET /api/sprites/{name}.{png|gif} fetches a missing piece from
// that host the first time anyone needs it and keeps it on disk.
//
// The proxy is allow-listed three ways: only Habitica's sprite host (one
// fixed base URL, redirects never followed), only image paths (a sprite name
// the shared catalog content/habitica-gear.json knows, with the extension it
// has upstream), and only images (PNG or GIF bytes, at most spriteMaxBytes).
// Nothing from the player's request goes upstream: no cookies, no headers,
// no Habitica credentials. The art is public; the request is ours.

// DefaultSpriteBaseURL is Habitica's public sprite host (docs/habitica-assets.md).
const DefaultSpriteBaseURL = "https://habitica-assets.s3.amazonaws.com/mobileApp/images/"

// spriteMaxBytes caps one sprite (the largest animated gear GIFs are ~10 KB).
const spriteMaxBytes = 256 << 10

// spriteMissTTL: how long an upstream "no such sprite" is remembered.
const spriteMissTTL = time.Hour

// spriteFetches: upstream fetches at once (the rest wait their turn).
const spriteFetches = 4

var spritePath = regexp.MustCompile(`^/api/sprites/([A-Za-z0-9_-]{1,80})\.(png|gif)$`)

var (
	pngMagic = []byte("\x89PNG\r\n\x1a\n")
	gifMagic = [][]byte{[]byte("GIF87a"), []byte("GIF89a")}
)

type spriteProxy struct {
	dir    string
	base   string
	client *http.Client
	known  map[string]string // sprite name -> its upstream extension
	slots  chan struct{}
	now    func() time.Time

	mu       sync.Mutex
	inflight map[string]*spriteCall
	missing  map[string]time.Time
}

type spriteCall struct {
	done chan struct{}
	body []byte
	err  error
}

var errSpriteMissing = errors.New("sprite-missing")

func newSpriteProxy(dir, base string, now func() time.Time) *spriteProxy {
	if dir == "" {
		dir = filepath.Join(os.TempDir(), "glimway-sprites")
	}
	if base == "" {
		base = DefaultSpriteBaseURL
	}
	if !strings.HasSuffix(base, "/") {
		base += "/"
	}
	known, err := knownSprites()
	if err != nil {
		// The catalog is embedded; a broken one fails its own tests first.
		known = map[string]string{}
	}
	return &spriteProxy{
		dir:  dir,
		base: base,
		client: &http.Client{
			Timeout: 10 * time.Second,
			// One host only: a redirect elsewhere is refused, not followed.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		known:    known,
		slots:    make(chan struct{}, spriteFetches),
		now:      now,
		inflight: map[string]*spriteCall{},
		missing:  map[string]time.Time{},
	}
}

// knownSprites lists every sprite name the avatar helpers can ask for
// (src/lib/habitica/avatar.ts assetSourceFor), from the shared catalog
// (content/habitica_gear.go's generated types).
func knownSprites() (map[string]string, error) {
	c := content.HabiticaGearRules
	gif := map[string]bool{}
	for _, n := range c.GifSprites {
		gif[n] = true
	}
	none := map[string]bool{}
	for _, n := range c.SpritelessGear {
		none[n] = true
	}
	out := map[string]string{}
	add := func(n string) {
		if gif[n] {
			out[n] = "gif"
		} else {
			out[n] = "png"
		}
	}
	a := c.GetAppearances()
	add("head_0")
	for _, s := range a.Skin {
		add("skin_" + s)
	}
	for _, size := range a.Size {
		for _, s := range a.Shirt {
			add(size + "_shirt_" + s)
		}
	}
	for slot, styles := range map[string][]string{"bangs": a.GetHair().Bangs, "base": a.GetHair().Base, "mustache": a.GetHair().Mustache, "beard": a.GetHair().Beard} {
		for _, style := range styles {
			if style == "0" {
				continue // style 0 is "none": no sprite
			}
			for _, color := range a.GetHair().Color {
				add(fmt.Sprintf("hair_%s_%s_%s", slot, style, color))
			}
		}
	}
	for _, f := range a.GetHair().Flower {
		if f != "0" {
			add("hair_flower_" + f)
		}
	}
	for _, ch := range a.Chair {
		if ch != "none" {
			add("chair_" + ch)
		}
	}
	for key, g := range c.Gear {
		if none[key] {
			continue
		}
		if g.GetType() == "armor" {
			// Armor sprites are size-prefixed upstream; a bare armor key 403s.
			for _, size := range a.Size {
				add(size + "_" + key)
			}
			continue
		}
		add(key)
	}
	for _, p := range c.Pets {
		add("Pet-" + p)
	}
	for _, m := range c.Mounts {
		add("Mount_Body_" + m)
		add("Mount_Head_" + m)
	}
	return out, nil
}

func (a *Server) sprite(w http.ResponseWriter, r *http.Request) error {
	m := spritePath.FindStringSubmatch(r.URL.Path)
	if m == nil {
		return fail(404, "not-found")
	}
	name, ext := m[1], m[2]
	p := a.sprites
	if want, ok := p.known[name]; !ok || want != ext {
		return fail(404, "not-found")
	}
	body, err := p.get(r.Context(), name, ext)
	if errors.Is(err, errSpriteMissing) {
		return fail(404, "not-found")
	}
	if err != nil {
		return fail(502, "upstream")
	}
	h := w.Header()
	h.Set("Content-Type", "image/"+ext)
	// Sprites never change under a name: the browser keeps them for good.
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	h.Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(200)
	if r.Method != "HEAD" {
		_, _ = w.Write(body)
	}
	return nil
}

// get returns a sprite from the disk cache, or fetches it once (concurrent
// asks for one name share the fetch) and keeps it.
func (p *spriteProxy) get(ctx context.Context, name, ext string) ([]byte, error) {
	file := filepath.Join(p.dir, name+"."+ext)
	if b, err := os.ReadFile(file); err == nil && validSprite(b, ext) {
		return b, nil
	}
	key := name + "." + ext
	p.mu.Lock()
	if at, ok := p.missing[key]; ok && p.now().Sub(at) < spriteMissTTL {
		p.mu.Unlock()
		return nil, errSpriteMissing
	}
	call, ok := p.inflight[key]
	if !ok {
		call = &spriteCall{done: make(chan struct{})}
		p.inflight[key] = call
		p.mu.Unlock()
		// Detached from the asker: a fetch others wait on finishes even if
		// the first asker goes away.
		go p.fetch(context.WithoutCancel(ctx), key, file, ext, call)
	} else {
		p.mu.Unlock()
	}
	select {
	case <-call.done:
		return call.body, call.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (p *spriteProxy) fetch(ctx context.Context, key, file, ext string, call *spriteCall) {
	defer func() {
		p.mu.Lock()
		delete(p.inflight, key)
		if errors.Is(call.err, errSpriteMissing) {
			p.missing[key] = p.now()
		}
		p.mu.Unlock()
		close(call.done)
	}()
	p.slots <- struct{}{}
	defer func() { <-p.slots }()
	call.body, call.err = p.download(ctx, key, ext)
	if call.err != nil {
		return
	}
	// Written whole, then renamed into place: a reader never sees half a file.
	if err := os.MkdirAll(p.dir, 0o755); err != nil {
		return
	}
	tmp, err := os.CreateTemp(p.dir, ".sprite-*")
	if err != nil {
		return
	}
	_, werr := tmp.Write(call.body)
	cerr := tmp.Close()
	if werr != nil || cerr != nil || os.Rename(tmp.Name(), file) != nil {
		_ = os.Remove(tmp.Name())
	}
}

func (p *spriteProxy) download(ctx context.Context, key, ext string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", p.base+key, nil)
	if err != nil {
		return nil, err
	}
	// A fresh request: nothing of the player's (cookies, tokens) rides along.
	req.Header.Set("Accept", "image/png, image/gif")
	res, err := p.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == 403 || res.StatusCode == 404:
		// S3 answers 403 for a name it doesn't have.
		return nil, errSpriteMissing
	case res.StatusCode != 200:
		return nil, fmt.Errorf("upstream status %d", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, spriteMaxBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > spriteMaxBytes {
		return nil, errors.New("sprite too large")
	}
	// The bytes decide, not the upstream Content-Type (some GIFs come back
	// as application/octet-stream).
	if !validSprite(b, ext) {
		return nil, errors.New("not an image")
	}
	return b, nil
}

func validSprite(b []byte, ext string) bool {
	if len(b) == 0 || len(b) > spriteMaxBytes {
		return false
	}
	if ext == "png" {
		return bytes.HasPrefix(b, pngMagic)
	}
	for _, m := range gifMagic {
		if bytes.HasPrefix(b, m) {
			return true
		}
	}
	return false
}
