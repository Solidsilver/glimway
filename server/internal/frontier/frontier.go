// Package frontier bounds generated outskirts around both the Wilds
// footprints and fixed town/plot ground. Rect bounds that union; Inside
// checks its actual shape (the outer corners are not all on the grid).
//
// Held land pushes a world's frontier out (lamps.md 2.2): every chunk within
// the content's held slack of a held chunk is inside too, no further south
// than the south limit. Each world's reach is kept here, worked out once
// from its held keys when they change (Set, from store/holds.go), so the
// checks every move and read make are a map lookup, never a scan of holds.
// Holds change only when one is taken or at the turning, so a world's reach
// grows the moment a camp is set and shrinks only at a turning.
//
// A world's reach has two views. The published one is what committed holds
// make (Set, Publish). A transaction that takes or lets go a hold stages its
// own (Stage) until it commits (Publish) or rolls back (Discard), the store's
// one connection running one transaction at a time. Inside, Rect and Held
// answer the open transaction's view, for code that holds the store's
// connection; InsidePublished answers for readers that don't (the presence
// socket), which must never see a hold that may yet roll back.
package frontier

import (
	"slices"
	"sync"

	"glimway/content"
	"glimway/server/internal/wilds"
)

// reach is one world's held reach: its held keys, the chunks past the
// static frontier their slack adds, and the bounds of the whole union.
type reach struct {
	held  [][2]int
	extra map[[2]int]struct{}
	rect  [4]int
}

var (
	mu     sync.RWMutex
	worlds = map[string]*reach{}
	// staged: the open transaction's reach, by world; nil holds none.
	staged = map[string]*reach{}
)

// Slack is the content's held slack, in chunks.
func Slack() int { return int(content.WildsRules.GetFrontier().GetHeldSlack()) }

func of(world string) *reach {
	mu.RLock()
	defer mu.RUnlock()
	if r, ok := staged[world]; ok {
		return r
	}
	return worlds[world]
}

func published(world string) *reach {
	mu.RLock()
	defer mu.RUnlock()
	return worlds[world]
}

func (r *reach) inside(cx, cy int) bool {
	if wilds.InsideReach(cx, cy) {
		return true
	}
	if r != nil {
		_, ok := r.extra[[2]int{cx, cy}]
		return ok
	}
	return false
}

// Inside: the chunk is in the world's reach, the static frontier or a held
// chunk's slack, as the open transaction sees it.
func Inside(world string, cx, cy int) bool { return of(world).inside(cx, cy) }

// InsidePublished is Inside as committed holds make it, for readers outside
// the store's transaction.
func InsidePublished(world string, cx, cy int) bool { return published(world).inside(cx, cy) }

// Rect bounds the world's reach.
func Rect(world string) (int, int, int, int) {
	if r := of(world); r != nil {
		return r.rect[0], r.rect[1], r.rect[2], r.rect[3]
	}
	return wilds.FrontierRect()
}

// Held is the world's held keys, by cy then cx (the near read names them).
func Held(world string) [][2]int {
	if r := of(world); r != nil {
		return slices.Clone(r.held)
	}
	return nil
}

// build works out the reach held keys add; nil for none.
func build(held [][2]int) *reach {
	held = slices.Clone(held)
	slices.SortFunc(held, func(a, b [2]int) int {
		if a[1] != b[1] {
			return a[1] - b[1]
		}
		return a[0] - b[0]
	})
	held = slices.Compact(held)
	if len(held) == 0 {
		return nil
	}
	x0, y0, x1, y1 := wilds.FrontierRect()
	r := &reach{held: held, extra: map[[2]int]struct{}{}}
	s, south := Slack(), int(content.WildsRules.GetFrontier().GetSouthLimit())
	for _, k := range held {
		for cy := k[1] - s; cy <= min(k[1]+s, south); cy++ {
			for cx := k[0] - s; cx <= k[0]+s; cx++ {
				if wilds.InsideReach(cx, cy) {
					continue
				}
				r.extra[[2]int{cx, cy}] = struct{}{}
				x0, y0, x1, y1 = min(x0, cx), min(y0, cy), max(x1, cx), max(y1, cy)
			}
		}
	}
	r.rect = [4]int{x0, y0, x1, y1}
	return r
}

func put(m map[string]*reach, world string, r *reach) {
	if r == nil {
		delete(m, world)
		return
	}
	m[world] = r
}

// Set publishes the world's held keys as committed, dropping any staged view
// of them.
func Set(world string, held [][2]int) {
	r := build(held)
	mu.Lock()
	defer mu.Unlock()
	delete(staged, world)
	put(worlds, world, r)
}

// Stage sets the world's held keys as the open transaction sees them.
func Stage(world string, held [][2]int) {
	r := build(held)
	mu.Lock()
	defer mu.Unlock()
	staged[world] = r
}

// Publish makes every staged view the published one: its transaction
// committed.
func Publish() {
	mu.Lock()
	defer mu.Unlock()
	for w, r := range staged {
		put(worlds, w, r)
	}
	clear(staged)
}

// Discard drops every staged view: its transaction rolled back.
func Discard() {
	mu.Lock()
	defer mu.Unlock()
	clear(staged)
}

// Reset forgets every world's held reach (a store opening reads them anew).
func Reset() {
	mu.Lock()
	defer mu.Unlock()
	worlds = map[string]*reach{}
	clear(staged)
}
