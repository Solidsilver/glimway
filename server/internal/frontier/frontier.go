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
)

// Slack is the content's held slack, in chunks.
func Slack() int { return int(content.WildsRules.GetFrontier().GetHeldSlack()) }

func of(world string) *reach {
	mu.RLock()
	defer mu.RUnlock()
	return worlds[world]
}

// Inside: the chunk is in the world's reach, the static frontier or a held
// chunk's slack.
func Inside(world string, cx, cy int) bool {
	if wilds.InsideReach(cx, cy) {
		return true
	}
	if r := of(world); r != nil {
		_, ok := r.extra[[2]int{cx, cy}]
		return ok
	}
	return false
}

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

// Set replaces the world's held keys, working out the reach they add.
func Set(world string, held [][2]int) {
	held = slices.Clone(held)
	slices.SortFunc(held, func(a, b [2]int) int {
		if a[1] != b[1] {
			return a[1] - b[1]
		}
		return a[0] - b[0]
	})
	held = slices.Compact(held)
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
	mu.Lock()
	defer mu.Unlock()
	if len(held) == 0 {
		delete(worlds, world)
		return
	}
	worlds[world] = r
}

// Reset forgets every world's held reach (a store opening reads them anew).
func Reset() {
	mu.Lock()
	defer mu.Unlock()
	worlds = map[string]*reach{}
}
