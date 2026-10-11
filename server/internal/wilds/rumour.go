package wilds

// A rumour each wick (open-map.md 2.10, decision 19). One place per world
// per wick, hashed, among the new cells' places inside the 0.8 frontier
// (never a footprint's cell). Its find is a site in front of the place's
// landmark, rumour:<cx>:<cy>, made with the chunk (it's a pure function of
// the epoch). The parts Elara's words are built from never name
// coordinates: the landmark, a compass word from the Commons gate (eight
// ways), how far out it lies, and whether the Wend lies between the gate and the
// place.

// RumourPick is this wick's rumour: the parts of contract.WildsRumour the
// generator knows.
type RumourPick struct {
	Place     Place  `json:"place"`
	Compass   string `json:"compass"` // n ne e se s sw w nw, from the Commons gate
	Ring      int    `json:"ring"`    // chunks from the nearest footprint, 1..the last distance word's ring
	PastRiver bool   `json:"pastRiver"`
	Site      string `json:"site"` // "rumour:<cx>:<cy>"
	SiteTX    int    `json:"siteTx"`
	SiteTY    int    `json:"siteTy"`
}

// Rumour is a wick epoch's rumour; false for a still epoch (or none).
func Rumour(e EpochV3) (RumourPick, bool) {
	if e.check() != nil || e.Kind != EpochWick {
		return RumourPick{}, false
	}
	return newWorld(e).rumour()
}

// rumourPlaces are the places the rumour can pick, in cell order.
func (w *world) rumourPlaces() []*Place {
	minCx, minCy, maxCx, maxCy := frontierChunks()
	x0, y0 := CellOf(minCx, minCy)
	x1, y1 := CellOf(maxCx, maxCy)
	var out []*Place
	for y := y0; y <= y1; y++ {
		for x := x0; x <= x1; x++ {
			if p := w.place(x, y); p != nil && insideReach(p.CX, p.CY) {
				out = append(out, p)
			}
		}
	}
	return out
}

func (w *world) rumour() (RumourPick, bool) {
	if !w.wick {
		return RumourPick{}, false
	}
	places := w.rumourPlaces()
	if len(places) == 0 {
		return RumourPick{}, false
	}
	p := places[w.e.hash("rumour")%uint32(len(places))]
	gx, gy := gateTile()
	lx, ly := p.tile()
	r := RumourPick{
		Place:   *p,
		Compass: compass(lx-gx, ly-gy),
		Ring:    rumourRing(p.CX, p.CY),
		Site:    rumourSiteID(p.CX, p.CY),
		SiteTX:  p.TX,
		SiteTY:  p.TY + 1,
	}
	if w.river != nil {
		r.PastRiver = w.river.line.crossCount(tileCentre(gx, gy), tileCentre(lx, ly))%2 == 1
	}
	return r, true
}

// rumourRing is the distance word's ring for a place: its chunk's distance
// from the nearest footprint, clamped to the rings content has words for
// (1..3). Not wilds.Ring: inside 0.8's frontier that is always 1, so every
// rumour would be "not far".
func rumourRing(cx, cy int) int {
	top := 1
	for _, d := range contentRules().GetRumour().GetDistance() {
		top = max(top, int(d.GetRing()))
	}
	return clamp(NearestFootprint(cx, cy), 1, top)
}

// compass is the eighth of the compass a step (dx, dy) points (north is
// -y): within 22.5° of an axis it's that axis (tan 22.5° ≈ 0.4142).
func compass(dx, dy int) string {
	ax, ay := abs(dx), abs(dy)
	ns, ew := "", ""
	if dy < 0 {
		ns = "n"
	} else if dy > 0 {
		ns = "s"
	}
	if dx > 0 {
		ew = "e"
	} else if dx < 0 {
		ew = "w"
	}
	switch {
	case ax*10000 <= ay*4142:
		if ns == "" {
			return "n"
		}
		return ns
	case ay*10000 <= ax*4142:
		return ew
	}
	return ns + ew
}
