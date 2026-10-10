package api

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A tiny valid-looking PNG / GIF (the proxy checks the signature, not pixels).
var (
	testPNG = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{1}, 32)...)
	testGIF = append([]byte("GIF89a"), bytes.Repeat([]byte{2}, 32)...)
)

type fakeSpriteHost struct {
	srv   *httptest.Server
	hits  atomic.Int64
	mu    sync.Mutex
	files map[string][]byte
	seen  []http.Header
	gate  chan struct{}
}

func newFakeSpriteHost(t *testing.T) *fakeSpriteHost {
	f := &fakeSpriteHost{files: map[string][]byte{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		f.mu.Lock()
		f.seen = append(f.seen, r.Header.Clone())
		b, ok := f.files[strings.TrimPrefix(r.URL.Path, "/images/")]
		gate := f.gate
		f.mu.Unlock()
		if gate != nil {
			<-gate
		}
		if r.URL.Path == "/images/redirect.png" {
			http.Redirect(w, r, "https://example.invalid/x.png", http.StatusFound)
			return
		}
		if !ok {
			w.WriteHeader(403) // S3's answer for a missing key
			return
		}
		// Some real GIFs come back typed as octet-stream: the proxy must not care.
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(b)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeSpriteHost) put(name string, b []byte) {
	f.mu.Lock()
	f.files[name] = b
	f.mu.Unlock()
}

func spriteServer(t *testing.T, host *fakeSpriteHost) (*Server, string) {
	dir := t.TempDir()
	return New(nil, nil, Config{SpriteCacheDir: dir, SpriteBaseURL: host.srv.URL + "/images/"}), dir
}

func getSprite(a *Server, path string, header http.Header) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", path, nil)
	r.Header.Set("X-Glimway-Contract", "6")
	for k, v := range header {
		r.Header[k] = v
	}
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	return w
}

func TestSpriteProxyFetchesOnceAndKeepsOnDisk(t *testing.T) {
	host := newFakeSpriteHost(t)
	host.put("slim_armor_warrior_2.png", testPNG)
	a, dir := spriteServer(t, host)

	w := getSprite(a, "/api/sprites/slim_armor_warrior_2.png", nil)
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), testPNG) {
		t.Fatalf("first fetch: %d %q", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content type %q", ct)
	}
	if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") || !strings.Contains(cc, "max-age=31536000") {
		t.Fatalf("cache control %q", cc)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "slim_armor_warrior_2.png")); err != nil || !bytes.Equal(b, testPNG) {
		t.Fatalf("not kept on disk: %v", err)
	}
	// Served from disk from now on, even by a fresh process.
	again := New(nil, nil, Config{SpriteCacheDir: dir, SpriteBaseURL: host.srv.URL + "/images/"})
	for _, s := range []*Server{a, again} {
		if w := getSprite(s, "/api/sprites/slim_armor_warrior_2.png", nil); w.Code != 200 {
			t.Fatalf("cached read: %d", w.Code)
		}
	}
	if n := host.hits.Load(); n != 1 {
		t.Fatalf("upstream hit %d times, want 1", n)
	}
}

func TestSpriteProxyAllowsOnlyCatalogImagePaths(t *testing.T) {
	host := newFakeSpriteHost(t)
	host.put("head_0.png", testPNG)
	a, _ := spriteServer(t, host)
	for _, path := range []string{
		"/api/sprites/not_a_sprite.png",       // unknown name
		"/api/sprites/armor_warrior_1.png",    // bare armor: never a sprite upstream
		"/api/sprites/head_0.gif",             // wrong extension for this sprite
		"/api/sprites/head_0.svg",             // not an image path we serve
		"/api/sprites/head_0",                 // no extension
		"/api/sprites/../api/state",           // traversal
		"/api/sprites/..%2Fhead_0.png",        // encoded traversal
		"/api/sprites/head_0.png/../../x.png", // nested
		"/api/sprites/weapon_base_0.png",      // the "none" pieces have no sprite
		"/api/sprites/hair_base_0_brown.png",  // style 0 is none
		"/api/sprites/https:%2F%2Fevil.png",   // another host
		"/api/sprites/" + strings.Repeat("a", 90) + ".png",
	} {
		if w := getSprite(a, path, nil); w.Code != 404 {
			t.Errorf("%s: %d, want 404", path, w.Code)
		}
	}
	if n := host.hits.Load(); n != 0 {
		t.Fatalf("refused paths reached upstream %d times", n)
	}
	// A gif sprite is served as one, whatever upstream calls it.
	host.put("head_special_0.gif", testGIF)
	w := getSprite(a, "/api/sprites/head_special_0.gif", nil)
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/gif" {
		t.Fatalf("gif: %d %q", w.Code, w.Header().Get("Content-Type"))
	}
	if w := getSprite(a, "/api/sprites/head_special_0.png", nil); w.Code != 404 {
		t.Fatalf("png for a gif sprite: %d", w.Code)
	}
}

func TestSpriteProxyRefusesWhatIsNotASprite(t *testing.T) {
	host := newFakeSpriteHost(t)
	host.put("head_warrior_3.png", []byte("<html>not an image</html>"))
	host.put("head_warrior_4.png", append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, spriteMaxBytes)...))
	host.put("head_warrior_5.png", testGIF) // a GIF where a PNG belongs
	a, dir := spriteServer(t, host)
	for _, name := range []string{"head_warrior_3", "head_warrior_4", "head_warrior_5"} {
		if w := getSprite(a, "/api/sprites/"+name+".png", nil); w.Code != 502 {
			t.Errorf("%s: %d, want 502", name, w.Code)
		}
		if _, err := os.Stat(filepath.Join(dir, name+".png")); err == nil {
			t.Errorf("%s was cached", name)
		}
	}
	// A redirect is never followed to another host.
	a.sprites.known["redirect"] = "png"
	if w := getSprite(a, "/api/sprites/redirect.png", nil); w.Code != 502 {
		t.Fatalf("redirect: %d", w.Code)
	}
}

func TestSpriteProxyRemembersMissingSprites(t *testing.T) {
	host := newFakeSpriteHost(t)
	a, _ := spriteServer(t, host)
	now := time.Unix(1_800_000_000, 0)
	a.sprites.now = func() time.Time { return now }
	for i := 0; i < 3; i++ {
		if w := getSprite(a, "/api/sprites/head_warrior_2.png", nil); w.Code != 404 {
			t.Fatalf("missing: %d", w.Code)
		}
	}
	if n := host.hits.Load(); n != 1 {
		t.Fatalf("a missing sprite was asked for %d times", n)
	}
	// After a while it's asked again (it may have been published since).
	host.put("head_warrior_2.png", testPNG)
	now = now.Add(spriteMissTTL + time.Second)
	if w := getSprite(a, "/api/sprites/head_warrior_2.png", nil); w.Code != 200 {
		t.Fatalf("after the miss expired: %d", w.Code)
	}
}

func TestSpriteProxyNeverForwardsThePlayersCredentials(t *testing.T) {
	host := newFakeSpriteHost(t)
	host.put("Pet-Wolf-Red.png", testPNG)
	a, _ := spriteServer(t, host)
	h := http.Header{}
	h.Set("Cookie", CookieName+"=secret-session")
	h.Set("Authorization", "Bearer secret")
	h.Set("X-Api-Key", "secret-token")
	h.Set("X-Api-User", "secret-user")
	if w := getSprite(a, "/api/sprites/Pet-Wolf-Red.png", h); w.Code != 200 {
		t.Fatalf("pet: %d", w.Code)
	}
	host.mu.Lock()
	defer host.mu.Unlock()
	for _, seen := range host.seen {
		for k, v := range seen {
			if strings.Contains(strings.Join(v, ","), "secret") {
				t.Fatalf("upstream saw %s: %v", k, v)
			}
		}
	}
}

func TestSpriteProxySharesOneFetchBetweenAskers(t *testing.T) {
	host := newFakeSpriteHost(t)
	host.put("Mount_Body_Wolf-Red.png", testPNG)
	host.gate = make(chan struct{})
	a, _ := spriteServer(t, host)
	var wg sync.WaitGroup
	codes := make([]int, 8)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = getSprite(a, "/api/sprites/Mount_Body_Wolf-Red.png", nil).Code
		}(i)
	}
	// Let the askers pile up on the one fetch, then let it through.
	deadline := time.Now().Add(5 * time.Second)
	for host.hits.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	close(host.gate)
	wg.Wait()
	for i, c := range codes {
		if c != 200 {
			t.Fatalf("asker %d: %d", i, c)
		}
	}
	if n := host.hits.Load(); n != 1 {
		t.Fatalf("upstream hit %d times, want 1", n)
	}
}

func TestKnownSpritesMatchTheCatalog(t *testing.T) {
	known, err := knownSprites()
	if err != nil {
		t.Fatal(err)
	}
	for name, ext := range map[string]string{
		"head_0": "png", "skin_915533": "png", "slim_shirt_blue": "png", "broad_armor_warrior_1": "png",
		"hair_bangs_1_TRUred": "png", "hair_flower_3": "png", "Pet-Wolf-Cerberus": "gif", "Mount_Head_Wolf-Base": "png",
		"weapon_wizard_1": "png", "back_special_heroicAureole": "gif",
	} {
		if known[name] != ext {
			t.Errorf("%s: %q, want %q", name, known[name], ext)
		}
	}
	for _, name := range []string{"armor_warrior_1", "weapon_base_0", "chair_none", "hair_flower_0"} {
		if _, ok := known[name]; ok {
			t.Errorf("%s should not be a sprite", name)
		}
	}
}
