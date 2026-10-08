package chunks

import (
	"context"
	"database/sql"
	"fmt"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/proto"
	"regexp"
)

var destination = regexp.MustCompile(`^chunk:(inner-1|outer-1):[0-2]:[0-2]$`)

// Validate checks immutable geometry, before storage and after binary decode.
// World ownership and lifetime remain the transactional source's responsibility.
func Validate(c *contract.WildsChunk) error {
	if c == nil || c.Size != 24 || c.EpochId == "" || (c.Region != "inner-1" && c.Region != "outer-1") || c.GeneratorVersion != 2 || c.Realm != "hearthwick" || c.Layer != 0 || (c.Look != "tangle" && c.Look != "outer") || c.Cx < 0 || c.Cx > 2 || c.Cy < 0 || c.Cy > 2 {
		return fmt.Errorf("invalid chunk identity")
	}
	if len(c.Palette) == 0 || len(c.Palette) > 16 || len(c.Ground) != 288 || len(c.Solid) != 72 {
		return fmt.Errorf("invalid cell packing")
	}
	for _, b := range c.Ground {
		if int(b&15) >= len(c.Palette) || int(b>>4) >= len(c.Palette) {
			return fmt.Errorf("invalid palette index")
		}
	}
	tile := func(x, y uint32) bool { return x < c.Size && y < c.Size }
	if c.Spawn == nil || !tile(c.Spawn.Tx, c.Spawn.Ty) || c.Decor == nil {
		return fmt.Errorf("missing chunk geometry")
	}
	d := c.Decor
	n := len(d.Kind)
	if len(d.Tx) != n || len(d.Ty) != n || len(d.Ox) != n || len(d.Oy) != n || len(d.Variant) != n || len(d.Flags) != (n+3)/4 {
		return fmt.Errorf("invalid decor packing")
	}
	for i, k := range d.Kind {
		if int(k) >= len(d.Kinds) || !tile(d.Tx[i], d.Ty[i]) {
			return fmt.Errorf("invalid decor tile")
		}
	}
	ids := map[string]bool{}
	add := func(id string, x, y uint32) bool {
		if id == "" || ids[id] || !tile(x, y) {
			return false
		}
		ids[id] = true
		return true
	}
	for _, s := range c.Sites {
		if s == nil || !add(s.Id, s.Tx, s.Ty) || s.Kind < contract.SiteKind_SITE_KIND_ECHO || s.Kind > contract.SiteKind_SITE_KIND_REEDS {
			return fmt.Errorf("invalid site")
		}
	}
	for _, e := range c.Entities {
		if e == nil || !add(e.Id, e.Tx, e.Ty) {
			return fmt.Errorf("invalid entity")
		}
		switch e.Kind {
		case "camp":
			if len(e.Enemies) == 0 {
				return fmt.Errorf("camp needs enemies")
			}
			for _, enemy := range e.Enemies {
				if enemy == "" {
					return fmt.Errorf("empty enemy")
				}
			}
		case "node":
			if e.Material == "" {
				return fmt.Errorf("node needs material")
			}
		case "chest":
			if e.Tier < 1 || e.Tier > 3 {
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
	for _, e := range c.Exits {
		if e == nil || !tile(e.Tx, e.Ty) || e.Tw == 0 || e.Th == 0 || e.Tw > 24-e.Tx || e.Th > 24-e.Ty || e.Entry == nil || e.Dir < contract.Dir_DIR_NORTH || e.Dir > contract.Dir_DIR_WEST {
			return fmt.Errorf("invalid exit")
		}
		w, h := uint32(24), uint32(24)
		if e.To == "commons" {
			w, h = 62, 42
		} else if !destination.MatchString(e.To) {
			return fmt.Errorf("unknown destination")
		}
		if e.Entry.Tx >= w || e.Entry.Ty >= h {
			return fmt.Errorf("invalid destination entry")
		}
	}
	return nil
}
func Entity(c *contract.WildsChunk, id string) (*contract.WildsEntity, error) {
	for _, e := range c.Entities {
		if e.Id == id {
			return proto.Clone(e).(*contract.WildsEntity), nil
		}
	}
	return nil, sql.ErrNoRows
}
func DecorAt(c *contract.WildsChunk, x, y uint32) []int {
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

type EpochKey struct{ World, Region string }
type FakeEpochs struct {
	Values      map[EpochKey]*contract.WildsEpoch
	CurrentFunc func(context.Context, *sql.Tx, string, string, int64) (*contract.WildsEpoch, error)
	CreateFunc  func(context.Context, *sql.Tx, string, string, int64) (*contract.WildsEpoch, error)
}

func (f FakeEpochs) Create(ctx context.Context, tx *sql.Tx, world, region string, now int64) (*contract.WildsEpoch, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.CreateFunc != nil {
		return f.CreateFunc(ctx, tx, world, region, now)
	}
	v := f.Values[EpochKey{world, region}]
	if v == nil {
		return nil, ErrUnavailable
	}
	return proto.Clone(v).(*contract.WildsEpoch), nil
}

func (f FakeEpochs) Current(ctx context.Context, tx *sql.Tx, world, region string, now int64) (*contract.WildsEpoch, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.CurrentFunc != nil {
		return f.CurrentFunc(ctx, tx, world, region, now)
	}
	v := f.Values[EpochKey{world, region}]
	if v == nil || v.GeneratorVersion != 2 {
		return nil, sql.ErrNoRows
	}
	if v.EndsAt != nil && v.EndsAt.Value <= float64(now) {
		return nil, ErrEpochEnded
	}
	return proto.Clone(v).(*contract.WildsEpoch), nil
}

// DecorWithin returns indices whose tile centres are within radius tiles.
func DecorWithin(c *contract.WildsChunk, x, y, radius float64) []int {
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
