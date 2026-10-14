package wilds

import (
	"fmt"
	"slices"

	"glimway/content"
)

// Pass 1, cells (open-map.md 2.2, 2.10). The world is cut into cells of
// cells.cellChunks square, aligned so the Tangle is cell (0, 0) and the
// Whitequiet cell (0, -1). Each cell that isn't a footprint's holds one
// place in a wick epoch: a camp glade, a ruin, an outcrop or a lone-tree
// rest, whichever content place kind fits the land at its spot. A place has
// a landmark (a tall blocking prop at its centre, seen from the next chunk
// over), a clearing around it, its kind's entities, and a find radius.
// The landmark sits well inside one chunk, clear of the Wend and the road,
// so its clearing never touches a chunk's edge tiles.

// Place is a cell's place.
type Place struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Landmark   string `json:"landmark"`
	CellX      int    `json:"cellX"`
	CellY      int    `json:"cellY"`
	CX         int    `json:"cx"`
	CY         int    `json:"cy"`
	TX         int    `json:"tx"`
	TY         int    `json:"ty"`
	FindRadius int    `json:"findRadius"`
	clearing   int
	entities   []string
}

// PlaceMark is a place whose landmark stands in a chunk, as the chunk
// carries it (WildsPlaceMark).
type PlaceMark struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	TX   int    `json:"tx"`
	TY   int    `json:"ty"`
}

// world tile of the landmark, and the front tiles south of it: the rumour's
// find stands on the first, routes end on the second.
func (p *Place) tile() (int, int) {
	S := chunkSize()
	return p.CX*S + p.TX, p.CY*S + p.TY
}

func (p *Place) front() (int, int) {
	x, y := p.tile()
	return x, y + 2
}

// PlaceAt is the place of a cell in a wick epoch; false for a footprint
// cell, a cell wholly south of the frontier's south limit, or a still
// epoch.
func PlaceAt(e Epoch, cellX, cellY int) (Place, bool) {
	if e.check() != nil {
		return Place{}, false
	}
	p := newWorld(e).place(cellX, cellY)
	if p == nil {
		return Place{}, false
	}
	return *p, true
}

// cellChunk0 is a cell's north-west chunk.
func cellChunk0(x, y int) (int, int) {
	c := contentRules().GetCells()
	n := int(c.GetCellChunks())
	return int(c.GetOriginCx()) + x*n, int(c.GetOriginCy()) + y*n
}

// cellBox is a cell's tiles in fp.
func cellBox(x, y int) box {
	S := chunkSize()
	n := int(contentRules().GetCells().GetCellChunks())
	cx, cy := cellChunk0(x, y)
	return tileBox(cx*S, cy*S, (cx+n)*S-1, (cy+n)*S-1)
}

const (
	placeTries = 16
	placeLo    = 8 // a landmark's local tile lies in [placeLo, S-1-placeLo]
)

var maxClearing = func() int {
	m := 0
	for _, k := range contentRules().PlaceKinds {
		m = max(m, int(k.GetClearingRadius()))
	}
	return m
}()

// place is a cell's place, or nil.
func (w *world) place(x, y int) *Place {
	key := [2]int{x, y}
	if p, ok := w.places[key]; ok {
		return p
	}
	w.places[key] = nil
	if !w.wick || FootprintCell(x, y) {
		return nil
	}
	S := chunkSize()
	n := int(contentRules().GetCells().GetCellChunks())
	south := int(contentRules().GetFrontier().GetSouthLimit())
	cx0, cy0 := cellChunk0(x, y)
	if cy0 > south {
		return nil
	}
	rng := NewRng(w.e.hash("place", x, y))
	// The spot: the first try clear of the river and the road, else the
	// try with the most room.
	type spot struct{ cx, cy, tx, ty, room int }
	var best *spot
	for a := 0; a < placeTries; a++ {
		s := spot{cx: cx0 + rng.NextInt(n), cy: cy0 + rng.NextInt(n), tx: rng.Between(placeLo, S-1-placeLo), ty: rng.Between(placeLo, S-1-placeLo)}
		if s.cy > south || FootprintAt(s.cx, s.cy) != nil || FixedFootprintAt(s.cx, s.cy) != nil {
			continue
		}
		p := tileCentre(s.cx*S+s.tx, s.cy*S+s.ty)
		room := 1 << 30
		if w.river != nil {
			d, half, _ := w.river.line.nearest(p, nil)
			room = min(room, (isqrt64(d)-half-bankWidth)/fp-maxClearing-3)
		}
		d, _, _ := w.road.line.nearest(p, nil)
		room = min(room, (isqrt64(d)-w.road.half)/fp-maxClearing-4)
		s.room = room
		if best == nil || room > best.room {
			best = &s
		}
		if room >= 0 {
			break
		}
	}
	if best == nil {
		return nil
	}
	tx, ty := best.cx*S+best.tx, best.cy*S+best.ty
	land := landName(w.landOne(tx, ty))
	var kinds []*content.WildsPlaceKind
	var weights []int
	for _, k := range contentRules().PlaceKinds {
		if k.GetLand() == land {
			kinds = append(kinds, k)
			weights = append(weights, int(k.GetWeight()))
		}
	}
	if len(kinds) == 0 {
		return nil
	}
	k := kinds[weighted(rng, weights)]
	p := &Place{
		ID: CellPlaceID(x, y), Kind: k.GetId(), Landmark: k.GetLandmark(),
		CellX: x, CellY: y, CX: best.cx, CY: best.cy, TX: best.tx, TY: best.ty,
		FindRadius: int(k.GetFindRadius()), clearing: int(k.GetClearingRadius()),
		entities: slices.Clone(k.GetEntities()),
	}
	w.places[key] = p
	return p
}

// placesIn lists the places whose landmark stands in chunk (cx, cy).
func (w *world) placesIn(cx, cy int) []*Place {
	x, y := CellOf(cx, cy)
	if p := w.place(x, y); p != nil && p.CX == cx && p.CY == cy {
		return []*Place{p}
	}
	return nil
}

func rumourSiteID(cx, cy int) string { return fmt.Sprintf("rumour:%d:%d", cx, cy) }

// isqrt64 is floor(sqrt(n)) for an int64 n >= 0.
func isqrt64(n int64) int {
	if n <= 0 {
		return 0
	}
	x := n
	y := (x + 1) / 2
	for y < x {
		x = y
		y = (x + n/x) / 2
	}
	return int(x)
}
