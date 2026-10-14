package chunks

import (
	"glimway/content"
	contentv1 "glimway/gen/glimway/content/v1"
	contract "glimway/server/internal/gen/glimway/v1"
)

// The world-changes layer over generated land (open-map.md section 3): a
// chunk with its ground changes applied, the land.go Effective pattern.
// Cleared tiles become walkable; laid tiles are walkable and carry their
// laid ground. The server uses it to check clears and lays and to find an
// open tile; the client applies the same changes to the chunk it draws.

// Ground changes, as GroundChange.change names them.
const (
	ChangeCleared = "cleared"
	ChangeStone   = "stone"
	ChangePlank   = "plank"
)

// Effective is a chunk's tiles with its changes on top. Changes may be nil.
type Effective struct {
	Chunk   *contract.WorldChunk
	changes map[[2]uint32]*contract.GroundChange
}

func NewEffective(c *contract.WorldChunk, changes *contract.GroundChanges) Effective {
	e := Effective{Chunk: c, changes: map[[2]uint32]*contract.GroundChange{}}
	for _, g := range changes.GetChanges() {
		e.changes[[2]uint32{g.Tx, g.Ty}] = g
	}
	return e
}

func (e Effective) inside(x, y int) bool {
	S := int(e.Chunk.Size)
	return x >= 0 && y >= 0 && x < S && y < S
}

// Change is the tile's change, or nil.
func (e Effective) Change(x, y int) *contract.GroundChange {
	if !e.inside(x, y) {
		return nil
	}
	return e.changes[[2]uint32{uint32(x), uint32(y)}]
}

// BaseSolid is the generated solid bit (true outside the chunk).
func (e Effective) BaseSolid(x, y int) bool {
	if !e.inside(x, y) {
		return true
	}
	i := y*int(e.Chunk.Size) + x
	return e.Chunk.Solid[i/8]&(1<<(i%8)) != 0
}

// Walkable: any change opens a tile; otherwise the generated bit.
func (e Effective) Walkable(x, y int) bool {
	if !e.inside(x, y) {
		return false
	}
	return e.Change(x, y) != nil || !e.BaseSolid(x, y)
}

// BaseGround is the generated content ground under a tile.
func (e Effective) BaseGround(x, y int) *content.WildsGround {
	if !e.inside(x, y) {
		return nil
	}
	i := y*int(e.Chunk.Size) + x
	k := int(e.Chunk.Ground[i/2]>>(4*(i%2))) & 15
	if k >= len(e.Chunk.Palette) {
		return nil
	}
	return GroundByTerrain(e.Chunk.Palette[k])
}

// Ground is the content ground a tile shows: a laid tile's laid ground,
// else the generated one.
func (e Effective) Ground(x, y int) *content.WildsGround {
	if c := e.Change(x, y); c != nil {
		if lay := LayKind(c.Change); lay != nil {
			return GroundByID(lay.GetGround())
		}
	}
	return e.BaseGround(x, y)
}

// Laid: a stone or plank path lies on the tile.
func (e Effective) Laid(x, y int) bool {
	c := e.Change(x, y)
	return c != nil && LayKind(c.Change) != nil
}

// LayKind is content's lay rule for a kind ("stone", "plank"), or nil.
func LayKind(kind string) *contentv1.WildsLayKind {
	for _, l := range content.WildsRules.GetPaths().GetLay() {
		if l.GetKind() == kind {
			return l
		}
	}
	return nil
}

// DecorKindsAt are the decor kinds standing on a tile.
func DecorKindsAt(c *contract.WorldChunk, x, y int) []string {
	out := []string{}
	if x < 0 || y < 0 {
		return out
	}
	for _, i := range DecorAt(c, uint32(x), uint32(y)) {
		out = append(out, c.Decor.Kinds[c.Decor.Kind[i]])
	}
	return out
}
