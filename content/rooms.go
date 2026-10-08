package content

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// Room maps are 16-pixel tiles. Floors share an outdoor parent.
type RoomTile struct {
	TX int `json:"tx"`
	TY int `json:"ty"`
}
type RoomDoor struct {
	ID      string    `json:"id"`
	Kind    string    `json:"kind"`
	At      string    `json:"at"`
	Side    string    `json:"side"`
	To      string    `json:"to"`
	Outside *RoomTile `json:"outside,omitempty"`
	Entry   RoomTile  `json:"entry"`
}
type RoomProp struct {
	Art   string `json:"art"`
	Char  string `json:"char"`
	Solid bool   `json:"solid"`
}
type RoomSpot struct {
	TX    int    `json:"tx"`
	TY    int    `json:"ty"`
	Label string `json:"label"`
}
type RoomLight struct {
	TX   int    `json:"tx"`
	TY   int    `json:"ty"`
	Kind string `json:"kind"`
	R    int    `json:"r"`
}
type RoomOutside struct {
	Building string    `json:"building"`
	Window   *RoomTile `json:"window,omitempty"`
	Chimney  *struct {
		X int `json:"x"`
		Y int `json:"y"`
	} `json:"chimney,omitempty"`
}
type Room struct {
	ID      string              `json:"id"`
	Name    string              `json:"name"`
	Parent  string              `json:"parent"`
	Map     []string            `json:"map"`
	Doors   []RoomDoor          `json:"doors"`
	Props   []RoomProp          `json:"props"`
	Spots   map[string]RoomSpot `json:"spots"`
	Lights  []RoomLight         `json:"lights"`
	Outside *RoomOutside        `json:"outside,omitempty"`
}
type Rooms struct {
	Legend map[string]string `json:"legend"`
	Rooms  []Room            `json:"rooms"`
}
type RoomFootprint struct {
	Char string `json:"char"`
	TX   int    `json:"tx"`
	TY   int    `json:"ty"`
	TW   int    `json:"tw"`
	TH   int    `json:"th"`
}

var roomID = regexp.MustCompile(`^in:(village|woodland|ruin|commons):([a-z0-9]+(?:-[a-z0-9]+)*)(?::([2-9]|[1-9][0-9]+))?$`)
var homeRoomID = regexp.MustCompile(`^in:home:(0|[1-9][0-9]{0,3})$`)
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
func RoomFor(area string) (Room, bool) {
	for _, r := range RoomRules.Rooms {
		if r.ID == area {
			return r, true
		}
	}
	return Room{}, false
}
func KnownContentArea(area string) bool {
	return slices.Contains([]string{"village", "woodland", "ruin", "commons"}, area) || KnownRoom(area)
}
func (r Room) ContainsTile(tx, ty int) bool {
	return ty >= 0 && ty < len(r.Map) && tx >= 0 && tx < len(r.Map[ty])
}
func (r Room) Walkable(tx, ty int) bool {
	if !r.ContainsTile(tx, ty) {
		return false
	}
	c := string(r.Map[ty][tx])
	if strings.Contains("#=w", c) {
		return false
	}
	for _, p := range r.Props {
		if p.Char == c {
			return !p.Solid
		}
	}
	return true
}

// RoomFootprints returns each four-connected group, in map order. Validation
// requires rectangles, so disconnected sacks can share a prop character.
func RoomFootprints(r Room, char string) []RoomFootprint {
	out := []RoomFootprint{}
	seen := map[RoomTile]bool{}
	for y, row := range r.Map {
		for x := range len(row) {
			start := RoomTile{x, y}
			if string(row[x]) != char || seen[start] {
				continue
			}
			queue := []RoomTile{start}
			seen[start] = true
			minX, maxX, minY, maxY := x, x, y, y
			for i := 0; i < len(queue); i++ {
				p := queue[i]
				minX = min(minX, p.TX)
				maxX = max(maxX, p.TX)
				minY = min(minY, p.TY)
				maxY = max(maxY, p.TY)
				for _, d := range []RoomTile{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
					n := RoomTile{p.TX + d.TX, p.TY + d.TY}
					if r.ContainsTile(n.TX, n.TY) && string(r.Map[n.TY][n.TX]) == char && !seen[n] {
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
func ValidateRooms(doc Rooms) error {
	bad := func(s string) error { return fmt.Errorf("invalid rooms: %s", s) }
	if len(doc.Rooms) == 0 || len(doc.Legend) != len(roomLegend) {
		return bad("empty rooms/legend")
	}
	for c, v := range roomLegend {
		if doc.Legend[c] != v {
			return bad("legend")
		}
	}
	seen := map[string]Room{}
	spots := map[string]bool{}
	var story Story
	if err := readTable("story.json", &story); err != nil {
		return err
	}
	for id := range story.Spots {
		spots[id] = true
	}
	for _, r := range doc.Rooms {
		m := roomID.FindStringSubmatch(r.ID)
		if _, ok := seen[r.ID]; ok || m == nil || r.Parent != m[1] || r.Name == "" || len(r.Map) < 3 || len(r.Map) > 128 || len(r.Map[0]) < 3 || len(r.Map[0]) > 128 || len(r.Doors) == 0 || r.Props == nil || r.Spots == nil || r.Lights == nil {
			return bad("room " + r.ID)
		}
		seen[r.ID] = r
		props := map[string]bool{}
		solidProps := map[string]bool{}
		for _, p := range r.Props {
			if len(p.Char) != 1 || p.Char[0] < 'A' || p.Char[0] > 'z' || p.Char[0] > 'Z' && p.Char[0] < 'a' || props[p.Char] || doc.Legend[p.Char] != "" || !ValidContentID(p.Art) {
				return bad("prop " + r.ID)
			}
			props[p.Char] = true
			solidProps[p.Char] = p.Solid
		}
		arrive := 0
		for y, row := range r.Map {
			if len(row) != len(r.Map[0]) {
				return bad("ragged map " + r.ID)
			}
			for x := range len(row) {
				c := string(row[x])
				if c == "@" {
					arrive++
				}
				if doc.Legend[c] == "" && !props[c] {
					return bad("unclaimed character " + r.ID)
				}
				if (x == 0 || y == 0 || x == len(row)-1 || y == len(r.Map)-1) && c != "#" && c != "D" && !solidProps[c] {
					return bad("open boundary " + r.ID)
				}
			}
		}
		for c := range props {
			groups := RoomFootprints(r, c)
			if len(groups) == 0 {
				return bad("unused prop " + r.ID)
			}
			for _, f := range groups {
				if f.TW == 0 {
					return bad("nonrectangular prop " + r.ID)
				}
			}
		}
		doors := map[string]bool{}
		chars := map[string]bool{}
		front := false
		for _, d := range r.Doors {
			if !ValidContentID(d.ID) || doors[d.ID] || chars[d.At] || !slices.Contains([]string{"north", "south", "east", "west"}, d.Side) || d.Kind != "door" && d.Kind != "stair" || d.Kind == "door" && (d.At != "D" || d.To != r.Parent || d.Outside == nil) || d.Kind == "stair" && (d.At != "^" && d.At != "v" || d.Outside != nil) || d.Entry.TX < 0 || d.Entry.TY < 0 {
				return bad("door " + r.ID)
			}
			if d.Outside != nil && (d.Outside.TX < 0 || d.Outside.TY < 0) {
				return bad("outside door " + r.ID)
			}
			groups := RoomFootprints(r, d.At)
			if len(groups) != 1 || groups[0].TW == 0 {
				return bad("door footprint " + r.ID)
			}
			if d.Kind == "door" {
				front = true
				f := groups[0]
				if d.Side == "north" && f.TY != 0 || d.Side == "south" && f.TY+f.TH != len(r.Map) || d.Side == "west" && f.TX != 0 || d.Side == "east" && f.TX+f.TW != len(r.Map[0]) {
					return bad("door side " + r.ID)
				}
			}
			doors[d.ID] = true
			chars[d.At] = true
		}
		for _, c := range []string{"D", "^", "v"} {
			if len(RoomFootprints(r, c)) > 0 && !chars[c] {
				return bad("unclaimed exit " + r.ID)
			}
		}
		if front && arrive != 1 || !front && arrive != 0 {
			return bad("arrival " + r.ID)
		}
		for id, s := range r.Spots {
			if !ValidContentID(id) || spots[id] || s.Label == "" || !r.ContainsTile(s.TX, s.TY) {
				return bad("spot " + id)
			}
			near := false
			for _, d := range []RoomTile{{0, 0}, {1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
				near = near || r.Walkable(s.TX+d.TX, s.TY+d.TY)
			}
			if !near {
				return bad("blocked spot " + id)
			}
			spots[id] = true
		}
		for _, l := range r.Lights {
			if !r.ContainsTile(l.TX, l.TY) || !slices.Contains([]string{"hearth", "lamp", "window"}, l.Kind) || l.R < 1 || l.R > 128 {
				return bad("light " + r.ID)
			}
		}
		if o := r.Outside; o != nil {
			if !ValidContentID(o.Building) || o.Window != nil && (o.Window.TX < 0 || o.Window.TY < 0) || o.Chimney != nil && (o.Chimney.X < 0 || o.Chimney.Y < 0) {
				return bad("outside " + r.ID)
			}
		}
	}
	for _, r := range doc.Rooms {
		if RoomParent(r.ID) != r.Parent {
			if _, ok := seen[RoomParent(r.ID)]; !ok {
				return bad("missing floor 1 " + r.ID)
			}
		}
		for _, d := range r.Doors {
			if d.Kind == "stair" {
				target, ok := seen[d.To]
				if !ok || target.Parent != r.Parent || !target.Walkable(d.Entry.TX, d.Entry.TY) || !slices.ContainsFunc(target.Doors, func(back RoomDoor) bool { return back.Kind == "stair" && back.To == r.ID }) {
					return bad("stair target " + r.ID)
				}
			}
		}
	}
	return nil
}
func LoadRooms() (Rooms, error) {
	var doc Rooms
	err := readTable("rooms.json", &doc)
	if err == nil {
		err = ValidateRooms(doc)
	}
	return doc, err
}

var RoomRules = func() Rooms {
	doc, err := LoadRooms()
	if err != nil {
		panic(err)
	}
	return doc
}()
