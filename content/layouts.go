package content

import (
	"fmt"
	"io/fs"
	"path"
	"slices"
	"strings"

	contentv1 "glimway/gen/glimway/content/v1"
)

// The authored layouts of the fixed places (content/layouts/<id>.json;
// docs/design/location-seam.md 1.2): ground, a solid grid and objects over a
// fixed place's whole footprint, which the server slices into fixed chunks
// (server/internal/chunks/fixed.go). Only the server reads them; the client
// gets the chunks. The schema lives in proto/glimway/content/v1/layout.proto.
type (
	Layout       = contentv1.Layout
	LayoutObject = contentv1.LayoutObject
)

// CuratedTerrains are the curated tile terrains a layout's palette may
// name: src/lib/tile.ts TERRAIN's keys, in its order (tests/commons-served.
// test.ts holds them equal).
var CuratedTerrains = []string{
	"grass_a", "grass_b", "grass_c", "flowers", "path_a", "path_b", "dirt", "sand",
	"water_a", "water_b", "bridge", "stone_a", "stone_b", "stone_crack", "wall_stone", "wall_moss",
	"roof", "roof_edge", "wall_house", "door", "window", "fence", "cobble", "cobble_moss",
	"planks", "planks_dark", "tilled",
}

// DecodeLayout reads one layout's JSON into the generated types, refusing
// nulls and unknown keys, then runs the schema's rules and the layout's own
// (layoutRules). That it fits its fixed place is LayoutsFor's.
func DecodeLayout(raw []byte) (*Layout, error) {
	doc := &Layout{}
	if err := decodeContentProto(raw, "layout", doc); err != nil {
		return doc, err
	}
	if err := contentValidate("layout", entryLists(doc, "objects"), doc); err != nil {
		return doc, err
	}
	return doc, layoutRules(doc)
}

// layoutRules: the grid's rows match its size, the palette names curated
// terrains by one character each and the rows use only it, the solid rows
// only '#' and '.'; object ids are unique, every object stands on the grid
// and has what its kind needs.
func layoutRules(l *Layout) error {
	bad := func(format string, args ...any) error {
		return fmt.Errorf("invalid layout %s: "+format, append([]any{l.GetId()}, args...)...)
	}
	w, h := int(l.GetWidth()), int(l.GetHeight())
	for c, t := range l.GetPalette() {
		if len(c) != 1 || c == "\"" || c == "\\" || c[0] < '!' || c[0] > '~' {
			return bad("palette key %q is not one printable character", c)
		}
		if !slices.Contains(CuratedTerrains, t) {
			return bad("palette %q names no curated terrain %q", c, t)
		}
	}
	if len(l.GetGround()) != h || len(l.GetSolid()) != h {
		return bad("%d ground and %d solid rows for height %d", len(l.GetGround()), len(l.GetSolid()), h)
	}
	for y := range h {
		g, s := l.GetGround()[y], l.GetSolid()[y]
		if len(g) != w || len(s) != w {
			return bad("row %d is not %d tiles wide", y, w)
		}
		for x := range w {
			if _, ok := l.GetPalette()[g[x:x+1]]; !ok {
				return bad("ground %d,%d: %q is not in the palette", x, y, g[x:x+1])
			}
			if s[x] != '#' && s[x] != '.' {
				return bad("solid %d,%d: %q is neither '#' nor '.'", x, y, s[x:x+1])
			}
		}
	}
	ids := map[string]bool{}
	x0, y0 := int(l.GetTx()), int(l.GetTy())
	for _, o := range l.GetObjects() {
		id := o.GetId()
		if ids[id] {
			return bad("duplicate object %s", id)
		}
		ids[id] = true
		if tx, ty := int(o.GetTx()), int(o.GetTy()); tx < x0 || ty < y0 || tx >= x0+w || ty >= y0+h {
			return bad("object %s: off the grid", id)
		}
		if msg := objectNeeds(o); msg != "" {
			return bad("object %s: %s", id, msg)
		}
	}
	return nil
}

// objectNeeds is what an object of its kind lacks ("" if nothing).
func objectNeeds(o *LayoutObject) string {
	switch o.GetKind() {
	case "tree":
		if (o.GetVariant() == "") != (o.GetWidth() == 0) {
			return "a tree's canopy needs its frame and its width"
		}
	case "overhang":
		if o.GetVariant() == "" || o.GetWidth() == 0 {
			return "an overhang needs its frame and its width"
		}
	case "prop", "lamp":
		if o.GetVariant() == "" || o.GetProp() == nil {
			return "a prop needs its frame and its prop"
		}
		if (o.GetKind() == "lamp") != (o.GetProp().GetLight() != "") {
			return "a lamp, and only a lamp, carries a light"
		}
	case "scenery", "well", "board":
		if o.GetVariant() == "" || o.GetArt() == nil {
			return "drawn art needs its key and its art"
		}
	case "gate":
		if (o.GetExit() == nil && o.GetTarget() != "lot-entry") || o.GetSide() == "" || o.GetTw() < 1 || o.GetTh() < 1 {
			return "a gate needs its side, its gap and its way through"
		}
	case "exit":
		if o.GetExit() == nil || o.GetTw() < 1 || o.GetTh() < 1 {
			return "an exit needs its rect and its way through"
		}
	case "npc-post":
		if o.GetNpc() == "" {
			return "a post needs its resident"
		}
	case "repair":
		if o.GetTarget() == "" {
			return "a repair site needs its repair"
		}
	case "gather":
		if o.GetTarget() == "" || o.GetLabel() == "" {
			return "a gathering spot needs its target and its label"
		}
	}
	if o.GetArt().GetTile() && o.GetKind() != "gather" {
		return "only a gathering spot's art stands for its tile"
	}
	return ""
}

// LayoutsFor reads every layout in the files and checks each against its
// fixed place: every fixed place has its layout, at its revision, covering
// exactly its footprint, with one gate object a gate anchor; no layout
// lies unused, and each file is named by its id.
func LayoutsFor(files fs.FS, p *Places, w *Wilds) (map[string]*Layout, error) {
	names, err := fs.Glob(files, "layouts/*.json")
	if err != nil {
		return nil, err
	}
	out := map[string]*Layout{}
	for _, name := range names {
		raw, err := fs.ReadFile(files, name)
		if err != nil {
			return nil, err
		}
		l, err := DecodeLayout(raw)
		if err != nil {
			return nil, err
		}
		if l.GetId()+".json" != path.Base(name) {
			return nil, fmt.Errorf("invalid layout %s: in %s", l.GetId(), name)
		}
		out[l.GetId()] = l
	}
	S := int(w.GetChunkSize())
	used := map[string]bool{}
	for _, f := range p.GetFixed() {
		l := out[f.GetLayout()]
		if l == nil {
			return nil, fmt.Errorf("invalid layouts: place %s has no layout %s", f.GetId(), f.GetLayout())
		}
		used[l.GetId()] = true
		if l.GetRevision() != f.GetRevision() {
			return nil, fmt.Errorf("invalid layout %s: revision %d, place %s says %d", l.GetId(), l.GetRevision(), f.GetId(), f.GetRevision())
		}
		x0, y0, x1, y1 := FixedChunks(f)
		ox, oy := int(f.GetOrigin().GetTx()), int(f.GetOrigin().GetTy())
		if int(l.GetTx()) != x0*S-ox || int(l.GetTy()) != y0*S-oy || int(l.GetWidth()) != (x1-x0+1)*S || int(l.GetHeight()) != (y1-y0+1)*S {
			return nil, fmt.Errorf("invalid layout %s: the grid is not place %s's footprint", l.GetId(), f.GetId())
		}
		capacity := GateCapacity(f)
		if f.GetKind() == "plots" {
			for _, owner := range p.GetFixed() {
				if owner.GetId() == "hearthwick" {
					capacity = GateCapacity(owner)
				}
			}
		}
		gates := map[int32]bool{}
		for _, o := range l.GetObjects() {
			if o.GetKind() != "gate" {
				continue
			}
			if gates[o.GetGate()] || int(o.GetGate()) >= capacity {
				return nil, fmt.Errorf("invalid layout %s: gate %d is past the capacity or twice", l.GetId(), o.GetGate())
			}
			if f.GetKind() == "plots" {
				owns := false
				for _, z := range f.GetZones() {
					owns = owns || z.GetPlace() == fmt.Sprintf("lot:%d", o.GetGate())
				}
				if !owns {
					return nil, fmt.Errorf("invalid layout %s: gate %d belongs to another lot column", l.GetId(), o.GetGate())
				}
			}
			gates[o.GetGate()] = true
		}
		if f.GetKind() == "plots" {
			capacity = len(f.GetZones())
		}
		if f.GetId() != "hearthwick" && len(gates) != capacity {
			return nil, fmt.Errorf("invalid layout %s: %d gates for place %s's %d gate anchors", l.GetId(), len(gates), f.GetId(), capacity)
		}
	}
	for id := range out {
		if !used[id] {
			return nil, fmt.Errorf("invalid layouts: no place lays out %s", id)
		}
	}
	return out, nil
}

// GateCapacity is a fixed place's gate capacity: its gate anchors, gate:0
// to gate:n-1 (placesRules). src/lib/places.ts gateCapacity is the twin.
func GateCapacity(p *FixedPlace) int {
	n := 0
	for _, a := range p.GetAnchors() {
		if strings.HasPrefix(a.GetId(), "gate:") || p.GetId() == "hearthwick" && strings.HasPrefix(a.GetId(), "lot:") {
			n++
		}
	}
	return n
}

// Layouts are the shipped layouts by id, checked against the shipped places.
var Layouts = func() map[string]*Layout {
	l, err := LayoutsFor(FS, PlacesRules, WildsRules)
	if err != nil {
		panic(err)
	}
	return l
}()
