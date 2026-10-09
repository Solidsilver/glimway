package content

import (
	"fmt"
	"slices"

	contentv1 "glimway/gen/glimway/content/v1"
)

// The village's daily rhythm: who lives where and where each one stands over
// the day. The schema and its field rules live in
// proto/glimway/content/v1/residents.proto; the rules that reach into rooms
// (a home that exists, a spot that fits) stay here, beside the loader.
type (
	Residents     = contentv1.Residents
	Resident      = contentv1.Resident
	ResidentSpot  = contentv1.ResidentSpot
	ResidentPhase = contentv1.ResidentPhase
)

// ValidateResidents runs the rules that reach across files and the cycle's
// arithmetic: spot areas and homes name rooms, spots stand somewhere real,
// and the cycle's minutes make one full period.
func ValidateResidents(doc *Residents) error {
	bad := func(s string) error { return fmt.Errorf("invalid residents: %s", s) }
	for _, r := range doc.GetResidents() {
		if r.GetHome() != "" {
			if _, ok := RoomFor(r.GetHome()); !ok {
				return bad("home " + r.GetId())
			}
		}
		for _, s := range r.GetSpots() {
			if !KnownContentArea(s.GetArea()) {
				return bad("spot " + r.GetId())
			}
			if room, ok := RoomFor(s.GetArea()); ok && !ResidentSpotFits(room, s) {
				return bad("blocked spot " + r.GetId())
			}
		}
		total := 0
		for _, p := range r.GetCycle() {
			total += int(p.GetMinutes())
		}
		if total != int(doc.GetPeriodMinutes()) {
			return bad("phase total " + r.GetId())
		}
	}
	return nil
}

// ResidentSpotFits: a seated resident may occupy furniture, with a walkable
// tile beside it. Walls and out-of-bounds tiles remain invalid, even when
// seated.
func ResidentSpotFits(room *Room, spot *ResidentSpot) bool {
	tx, ty := int(spot.GetTx()), int(spot.GetTy())
	if roomWalkable(room, tx, ty) {
		return true
	}
	if !spot.GetSeated() || !roomContainsTile(room, tx, ty) {
		return false
	}
	char := string(room.GetMap()[ty][tx])
	if !slices.ContainsFunc(room.GetProps(), func(p *RoomProp) bool { return p.GetChar() == char }) {
		return false
	}
	for _, d := range []tileXY{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
		if roomWalkable(room, tx+d.x, ty+d.y) {
			return true
		}
	}
	return false
}

// DecodeResidents reads residents JSON into the generated types, refusing
// nulls and unknown fields, then runs the schema's rules and
// ValidateResidents.
func DecodeResidents(raw []byte) (*Residents, error) {
	doc := &Residents{}
	if err := decodeContentProto(raw, doc); err != nil {
		return doc, err
	}
	ids := make([]string, len(doc.GetResidents()))
	for i, r := range doc.GetResidents() {
		ids[i] = r.GetId()
	}
	if err := contentValidate("residents", "residents", ids, doc); err != nil {
		return doc, err
	}
	return doc, ValidateResidents(doc)
}

func LoadResidents() (*Residents, error) {
	raw, err := FS.ReadFile("residents.json")
	if err != nil {
		return nil, err
	}
	return DecodeResidents(raw)
}

var ResidentRules = func() *Residents {
	doc, err := LoadResidents()
	if err != nil {
		panic(err)
	}
	return doc
}()

func ResidentByID(id string) (*Resident, bool) {
	for _, r := range ResidentRules.GetResidents() {
		if r.GetId() == id {
			return r, true
		}
	}
	return nil, false
}

// ResidentAt resolves the named spot into an area and tile; times are Unix seconds.
func ResidentAt(id string, now float64) (*ResidentSpot, bool) {
	r, ok := ResidentByID(id)
	if !ok {
		return nil, false
	}
	return r.GetSpots()[CycleAt(r, now).Spot], true
}
