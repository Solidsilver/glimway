package chunks

import (
	"database/sql"
	"fmt"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/proto"
	"regexp"
	"slices"
	"strings"
)

var placeMarkID = regexp.MustCompile(`^place:-?[0-9]{1,6}:-?[0-9]{1,6}$`)

// knownLook: a chunk's look is one of the footprints' (the Beyond wears
// the Whitequiet's, generator v3).
func knownLook(look string) bool {
	return slices.ContainsFunc(content.WildsRules.Places, func(p *content.WildsPlace) bool { return p.GetLook() == look })
}

// Validate checks immutable geometry, before storage and after binary decode
// (open-map.md 2.2, 2.5): identity, sizes, the palette and decor against
// content's vocabularies, sites, entities and place marks. World ownership
// and lifetime remain the transactional source's responsibility. A fixed
// chunk is validateFixed's; a generated one never takes a fixed epoch id.
func Validate(c *contract.WorldChunk) error {
	if c != nil && c.Source == contract.ChunkSource_CHUNK_SOURCE_FIXED {
		return validateFixed(c)
	}
	w := content.WildsRules
	S := uint32(w.GetChunkSize())
	if c == nil || c.Source != contract.ChunkSource_CHUNK_SOURCE_UNSPECIFIED || c.LayoutRevision != 0 || len(c.Objects) > 0 || IsFixedEpoch(c.EpochId) || strings.HasPrefix(c.EpochId, "plot:") || c.Size != S || c.EpochId == "" || c.GeneratorVersion < 3 || c.Realm != w.GetRealm() || c.Layer != 0 || !knownLook(c.Look) || len(c.Mark) > 64 {
		return fmt.Errorf("invalid chunk identity")
	}
	if c.Tier < 1 || int(c.Tier) > len(w.Tiers) || !slices.ContainsFunc(w.Lands, func(l *content.WildsLand) bool { return l.GetId() == c.Land }) {
		return fmt.Errorf("invalid tier or land")
	}
	cells := int(S * S)
	if len(c.Palette) == 0 || len(c.Palette) > 16 || len(c.Ground) != cells/2 || len(c.Solid) != cells/8 {
		return fmt.Errorf("invalid cell packing")
	}
	for _, p := range c.Palette {
		if GroundByTerrain(p) == nil {
			return fmt.Errorf("unknown ground %q", p)
		}
	}
	for _, b := range c.Ground {
		if int(b&15) >= len(c.Palette) || int(b>>4) >= len(c.Palette) {
			return fmt.Errorf("invalid palette index")
		}
	}
	tile := func(x, y uint32) bool { return x < c.Size && y < c.Size }
	if c.Decor == nil {
		return fmt.Errorf("missing chunk geometry")
	}
	d := c.Decor
	n := len(d.Kind)
	if len(d.Tx) != n || len(d.Ty) != n || len(d.Ox) != n || len(d.Oy) != n || len(d.Variant) != n || len(d.Flags) != (n+3)/4 {
		return fmt.Errorf("invalid decor packing")
	}
	for _, k := range d.Kinds {
		if !slices.ContainsFunc(w.Decor, func(dk *content.WildsDecorKind) bool { return dk.GetKind() == k }) {
			return fmt.Errorf("unknown decor kind %q", k)
		}
	}
	for i, k := range d.Kind {
		if int(k) >= len(d.Kinds) || !tile(d.Tx[i], d.Ty[i]) {
			return fmt.Errorf("invalid decor tile")
		}
	}
	ids := map[string]bool{}
	add := func(id string, x, y uint32) bool {
		if id == "" || len(id) > 128 || ids[id] || !tile(x, y) {
			return false
		}
		ids[id] = true
		return true
	}
	for _, s := range c.Sites {
		if s == nil || !add(s.Id, s.Tx, s.Ty) || s.Kind < contract.SiteKind_SITE_KIND_ECHO || s.Kind > contract.SiteKind_SITE_KIND_RUMOUR {
			return fmt.Errorf("invalid site")
		}
	}
	for _, e := range c.Entities {
		if e == nil || !add(e.Id, e.Tx, e.Ty) {
			return fmt.Errorf("invalid entity")
		}
		switch e.Kind {
		case "camp":
			if len(e.Enemies) == 0 || slices.Contains(e.Enemies, "") {
				return fmt.Errorf("camp needs enemies")
			}
		case "node":
			if e.Material == "" {
				return fmt.Errorf("node needs material")
			}
		case "chest":
			if e.Tier < 1 || int(e.Tier) > len(w.Tiers) {
				return fmt.Errorf("invalid chest tier")
			}
		case "poi":
			if e.Poi == "" {
				return fmt.Errorf("poi needs id")
			}
		default:
			return fmt.Errorf("invalid entity kind")
		}
	}
	for _, p := range c.Places {
		if p == nil || !placeMarkID.MatchString(p.Id) || !add(p.Id, p.Tx, p.Ty) || !slices.ContainsFunc(w.PlaceKinds, func(k *content.WildsPlaceKind) bool { return k.GetId() == p.Kind }) {
			return fmt.Errorf("invalid place mark")
		}
	}
	return nil
}

// GroundByTerrain is the content ground a chunk palette entry names (the
// palette carries each ground's terrain), or nil.
func GroundByTerrain(terrain string) *content.WildsGround {
	for _, g := range content.WildsRules.Grounds {
		if g.GetTerrain() == terrain {
			return g
		}
	}
	return nil
}

// GroundByID is the content ground with the id, or nil.
func GroundByID(id string) *content.WildsGround {
	for _, g := range content.WildsRules.Grounds {
		if g.GetId() == id {
			return g
		}
	}
	return nil
}

func Entity(c *contract.WorldChunk, id string) (*contract.WildsEntity, error) {
	for _, e := range c.Entities {
		if e.Id == id {
			return proto.Clone(e).(*contract.WildsEntity), nil
		}
	}
	return nil, sql.ErrNoRows
}
func DecorAt(c *contract.WorldChunk, x, y uint32) []int {
	out := []int{}
	if c.Decor != nil {
		for i, tx := range c.Decor.Tx {
			if tx == x && c.Decor.Ty[i] == y {
				out = append(out, i)
			}
		}
	}
	return out
}

// DecorWithin returns indices whose tile centres are within radius tiles.
func DecorWithin(c *contract.WorldChunk, x, y, radius float64) []int {
	out := []int{}
	if c == nil || c.Decor == nil || radius < 0 {
		return out
	}
	for i, tx := range c.Decor.Tx {
		dx, dy := float64(tx)+0.5-x, float64(c.Decor.Ty[i])+0.5-y
		if dx*dx+dy*dy <= radius*radius {
			out = append(out, i)
		}
	}
	return out
}
