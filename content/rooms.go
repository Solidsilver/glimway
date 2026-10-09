package content

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

	contentv1 "glimway/gen/glimway/content/v1"
)

// The hand-made places: tile maps with their props, spots, lights and
// dressing, floors sharing an outdoor parent. The schema and its field rules
// live in proto/glimway/content/v1/rooms.proto; the rules that read the map
// (characters, footprints, doors, where a piece may stand) stay here, beside
// the loader, as canPlace does for pieces.
type (
	Rooms              = contentv1.Rooms
	Room               = contentv1.Room
	RoomDoor           = contentv1.RoomDoor
	RoomProp           = contentv1.RoomProp
	RoomFurnishing     = contentv1.RoomFurnishing
	RoomSpot           = contentv1.RoomSpot
	RoomLight          = contentv1.RoomLight
	RoomOutside        = contentv1.RoomOutside
	RoomOutsideChimney = contentv1.RoomOutside_Chimney
	RoomTile           = contentv1.RoomTile
)

// Room maps are 16-pixel tiles. Floors share an outdoor parent.
var roomID = regexp.MustCompile(`^in:(village|woodland|ruin|commons):([a-z0-9]+(?:-[a-z0-9]+)*)(?::([2-9]|[1-9][0-9]+))?$`)
var homeRoomID = regexp.MustCompile(`^in:home:(0|[1-9][0-9]{0,3})$`)

// The room vocabulary, checked on the schema; walking the map uses it.
var roomLegend = map[string]string{"#": "wall", "=": "back-wall", "w": "window", ".": "planks", ":": "flagstone", "D": "doorway", "^": "stairs-up", "v": "stairs-down", "@": "arrive"}

// RoomParent also parses removed rooms, for saved-place recovery on a state read.
// Non-room areas are returned unchanged.
func RoomParent(area string) string {
	if homeRoomID.MatchString(area) {
		return strings.TrimPrefix(area, "in:")
	}
	m := roomID.FindStringSubmatch(area)
	if m == nil {
		return area
	}
	if m[3] != "" {
		return "in:" + m[1] + ":" + m[2]
	}
	return m[1]
}
func RootArea(area string) string {
	if homeRoomID.MatchString(area) {
		return strings.TrimPrefix(area, "in:")
	}
	if m := roomID.FindStringSubmatch(area); m != nil {
		return m[1]
	}
	return area
}
func KnownRoom(area string) bool { _, ok := RoomFor(area); return ok || homeRoomID.MatchString(area) }
func RoomFor(area string) (*Room, bool) {
	for _, r := range RoomRules.Rooms {
		if r.GetId() == area {
			return r, true
		}
	}
	return nil, false
}
func KnownContentArea(area string) bool {
	return slices.Contains([]string{"village", "woodland", "ruin", "commons"}, area) || KnownRoom(area)
}

// tileXY is a map tile address; generated tiles carry presence, so the map
// walking code keys on this instead.
type tileXY struct{ x, y int }

func roomContainsTile(r *Room, tx, ty int) bool {
	return ty >= 0 && ty < len(r.GetMap()) && tx >= 0 && tx < len(r.GetMap()[ty])
}

// roomWalkable: a tile is open floor unless a wall, a window or a solid prop
// stands on it.
func roomWalkable(r *Room, tx, ty int) bool {
	if !roomContainsTile(r, tx, ty) {
		return false
	}
	c := string(r.GetMap()[ty][tx])
	if strings.Contains("#=w", c) {
		return false
	}
	for _, p := range r.GetProps() {
		if p.GetChar() == c {
			return !p.GetSolid()
		}
	}
	return true
}

// RoomFootprint is one rectangular group of a map letter, in map order.
type RoomFootprint struct {
	Char string `json:"char"`
	TX   int    `json:"tx"`
	TY   int    `json:"ty"`
	TW   int    `json:"tw"`
	TH   int    `json:"th"`
}

// RoomFootprints returns each four-connected group, in map order. Validation
// requires rectangles, so disconnected sacks can share a prop character.
func RoomFootprints(r *Room, char string) []RoomFootprint {
	out := []RoomFootprint{}
	seen := map[tileXY]bool{}
	for y, row := range r.GetMap() {
		for x := range len(row) {
			start := tileXY{x, y}
			if string(row[x]) != char || seen[start] {
				continue
			}
			queue := []tileXY{start}
			seen[start] = true
			minX, maxX, minY, maxY := x, x, y, y
			for i := 0; i < len(queue); i++ {
				p := queue[i]
				minX = min(minX, p.x)
				maxX = max(maxX, p.x)
				minY = min(minY, p.y)
				maxY = max(maxY, p.y)
				for _, d := range []tileXY{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
					n := tileXY{p.x + d.x, p.y + d.y}
					if roomContainsTile(r, n.x, n.y) && string(r.GetMap()[n.y][n.x]) == char && !seen[n] {
						seen[n] = true
						queue = append(queue, n)
					}
				}
			}
			f := RoomFootprint{char, minX, minY, maxX - minX + 1, maxY - minY + 1}
			if f.TW*f.TH != len(queue) {
				f.TW = 0
			}
			out = append(out, f)
		}
	}
	return out
}

// validateRooms runs the rules that read the map or reach across rooms: prop
// and door geometry, claimed characters, where a room's spots and pieces
// stand, stairs, and every reference between rooms. Field rules live on the
// schema (proto/glimway/content/v1/rooms.proto); it assumes the schema has
// passed, so it is only called after protovalidate.
func validateRooms(doc *Rooms) error {
	bad := func(s string) error { return fmt.Errorf("invalid rooms: %s", s) }
	seen := map[string]*Room{}
	spots := map[string]bool{}
	var story Story
	if err := readTable("story.json", &story); err != nil {
		return err
	}
	for id := range story.Spots {
		spots[id] = true
	}
	for _, r := range doc.Rooms {
		if _, ok := seen[r.GetId()]; ok {
			return bad("duplicate id " + r.GetId())
		}
		seen[r.GetId()] = r
		props := map[string]bool{}
		solidProps := map[string]bool{}
		for _, p := range r.GetProps() {
			// Every prop is a catalogue piece, in a facing it has.
			piece, ok := FurnishingFor(p.GetArt())
			_, has := piece.GetFacings()[p.GetFacing()]
			if !ok || p.GetFacing() != "" && !has {
				return bad("prop piece " + r.GetId() + " " + p.GetArt())
			}
			props[p.GetChar()] = true
			solidProps[p.GetChar()] = p.GetSolid()
		}
		arrive := 0
		for y, row := range r.GetMap() {
			for x := range len(row) {
				c := string(row[x])
				if c == "@" {
					arrive++
				}
				if roomLegend[c] == "" && !props[c] {
					return bad("unclaimed character " + r.GetId())
				}
				if (x == 0 || y == 0 || x == len(row)-1 || y == len(r.GetMap())-1) && c != "#" && c != "D" && !solidProps[c] {
					return bad("open boundary " + r.GetId())
				}
			}
		}
		for _, p := range r.GetProps() {
			groups := RoomFootprints(r, p.GetChar())
			if len(groups) == 0 {
				return bad("unused prop " + r.GetId())
			}
			piece, _ := FurnishingFor(p.GetArt())
			for _, f := range groups {
				if f.TW == 0 || f.TW != int(piece.GetFootprint()[0]) || f.TH != int(piece.GetFootprint()[1]) {
					return bad("prop footprint " + r.GetId())
				}
			}
		}
		chars := map[string]bool{}
		front := false
		for _, d := range r.GetDoors() {
			groups := RoomFootprints(r, d.GetAt())
			if len(groups) != 1 || groups[0].TW == 0 {
				return bad("door footprint " + r.GetId())
			}
			if d.GetKind() == "door" {
				front = true
				f := groups[0]
				if d.GetSide() == "north" && f.TY != 0 || d.GetSide() == "south" && f.TY+f.TH != len(r.GetMap()) || d.GetSide() == "west" && f.TX != 0 || d.GetSide() == "east" && f.TX+f.TW != len(r.GetMap()[0]) {
					return bad("door side " + r.GetId())
				}
			}
			chars[d.GetAt()] = true
		}
		for _, c := range []string{"D", "^", "v"} {
			if len(RoomFootprints(r, c)) > 0 && !chars[c] {
				return bad("unclaimed exit " + r.GetId())
			}
		}
		if front && arrive != 1 || !front && arrive != 0 {
			return bad("arrival " + r.GetId())
		}
		for id, s := range r.GetSpots() {
			if spots[id] {
				return bad("spot " + id)
			}
			tx, ty := int(s.GetTx()), int(s.GetTy())
			if !roomContainsTile(r, tx, ty) {
				return bad("spot " + id)
			}
			near := false
			for _, d := range []tileXY{{0, 0}, {1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
				near = near || roomWalkable(r, tx+d.x, ty+d.y)
			}
			if !near {
				return bad("blocked spot " + id)
			}
			spots[id] = true
		}
		for _, l := range r.GetLights() {
			if !roomContainsTile(r, int(l.GetTx()), int(l.GetTy())) {
				return bad("light " + r.GetId())
			}
		}
		if !validRoomFurnishings(r) {
			return bad("furnishings " + r.GetId())
		}
	}
	for _, r := range doc.Rooms {
		// A floor shares its outdoor parent's building: floor 1 must exist.
		if parent := RoomParent(r.GetId()); parent != r.GetParent() {
			if _, ok := seen[parent]; !ok {
				return bad("missing floor 1 " + r.GetId())
			}
		}
		for _, d := range r.GetDoors() {
			if d.GetKind() == "stair" {
				target, ok := seen[d.GetTo()]
				if !ok || target.GetParent() != r.GetParent() || !roomWalkable(target, int(d.GetEntry().GetTx()), int(d.GetEntry().GetTy())) || !slices.ContainsFunc(target.GetDoors(), func(back *RoomDoor) bool { return back.GetKind() == "stair" && back.GetTo() == r.GetId() }) {
					return bad("stair target " + r.GetId())
				}
			}
		}
	}
	return nil
}

// The floor a free-standing furnishing may stand on, and the back wall where wall pieces hang.
const roomFloor = ".:@"
const roomBackWall = "=w"

// validRoomFurnishings: every piece known, in a facing it has, placed where
// CanPlace lets it go: on a piece listed before it (its offer and slot), on
// the back wall, or on open floor (a rug under it counts as the floor), inside
// the room and off the props. The same rule as src/lib/rooms.ts.
func validRoomFurnishings(r *Room) bool {
	type placedPiece struct {
		piece *Furnishing
		tiles map[tileXY]bool
	}
	var placed []placedPiece
	for i, f := range r.GetFurnishings() {
		piece, ok := FurnishingFor(f.GetPiece())
		if !ok {
			return false
		}
		if _, has := piece.GetFacings()[f.GetFacing()]; f.GetFacing() != "" && !has {
			return false
		}
		if f.Parent != nil {
			if int(f.GetParent()) < 0 || int(f.GetParent()) >= i || f.Tx != nil || f.Ty != nil {
				return false
			}
			offer, slot := f.GetOffer(), 0
			if offer == "" {
				offer = "top"
			}
			if f.Slot != nil {
				slot = int(f.GetSlot())
			}
			host := placed[int(f.GetParent())].piece
			if offer != "top" && offer != "shelves" || slot < 0 || !CanPlace(piece, PlaceOn{Kind: "surface", Host: host, Offer: offer}, slot) {
				return false
			}
			placed = append(placed, placedPiece{piece, map[tileXY]bool{}})
			continue
		}
		if f.Offer != nil || f.Slot != nil || f.Tx == nil || f.Ty == nil || f.GetTx() < 0 || f.GetTy() < 0 {
			return false
		}
		tiles := map[tileXY]bool{}
		for y := int(f.GetTy()); y < int(f.GetTy())+int(piece.GetFootprint()[1]); y++ {
			for x := int(f.GetTx()); x < int(f.GetTx())+int(piece.GetFootprint()[0]); x++ {
				if !roomContainsTile(r, x, y) {
					return false
				}
				c := string(r.GetMap()[y][x])
				if piece.GetMount() == "wall" {
					// The back wall, or in front of a piece standing against it on its row (a shelf's sign).
					onProp := y == 1 && slices.ContainsFunc(r.GetProps(), func(p *RoomProp) bool { return p.GetChar() == c })
					if !strings.Contains(roomBackWall, c) && !onProp {
						return false
					}
				} else if !strings.Contains(roomFloor, c) {
					return false
				}
				tiles[tileXY{x, y}] = true
			}
		}
		onRug, rugUnder := false, false
		for _, p := range placed {
			if p.piece.GetLayer() != "under" {
				continue
			}
			all := true
			for t := range tiles {
				all = all && p.tiles[t]
				rugUnder = rugUnder || p.tiles[t]
			}
			onRug = onRug || all
		}
		onto := "floor"
		if piece.GetMount() == "wall" {
			onto = "wall"
		} else if onRug {
			onto = "rug"
		}
		// A rug never lies on another rug.
		if !CanPlace(piece, PlaceOn{Kind: onto}, 0) || piece.GetLayer() == "under" && rugUnder {
			return false
		}
		placed = append(placed, placedPiece{piece, tiles})
	}
	return true
}

// DecodeRooms reads rooms JSON into the generated types, refusing nulls and
// unknown keys, then runs the schema's rules and validateRooms.
func DecodeRooms(raw []byte) (*Rooms, error) {
	doc := &Rooms{}
	if err := decodeContentProto(raw, "rooms", doc); err != nil {
		return doc, err
	}
	entries := []entryList{{field: "rooms", ids: make([]string, len(doc.Rooms))}}
	for i, r := range doc.Rooms {
		entries[0].ids[i] = r.GetId()
	}
	if err := contentValidate("rooms", entries, doc); err != nil {
		return doc, err
	}
	return doc, validateRooms(doc)
}

func LoadRooms() (*Rooms, error) {
	raw, err := FS.ReadFile("rooms.json")
	if err != nil {
		return nil, err
	}
	return DecodeRooms(raw)
}

var RoomRules = func() *Rooms {
	doc, err := LoadRooms()
	if err != nil {
		panic(err)
	}
	return doc
}()
