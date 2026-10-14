// Package wildsgen is the server's generator: chunks.Generator over
// generator v3 (server/internal/wilds, docs/design/open-map.md 2.2). The
// store calls it to make a chunk on its first read; the near read and the
// rumour call Glimpses and Rumour, which never make or store anything.
package wildsgen

import (
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/wilds"
)

// V3 is generator v3.
type V3 struct{}

var _ chunks.Generator = V3{}

// Epoch is a stored epoch's generation parameters.
func Epoch(e *contract.WildsEpoch) wilds.Epoch {
	return wilds.Epoch{WorldSeed: e.WorldSeed, Kind: e.Kind, GeneratorVersion: int(e.GeneratorVersion), Season: e.Season}
}

func (V3) Version() int { return wilds.GeneratorV3 }

func (V3) Chunk(e *contract.WildsEpoch, cx, cy int32, kept []chunks.Kept) (*contract.WorldChunk, error) {
	k := make([]wilds.Kept, len(kept))
	for i, n := range kept {
		k[i] = wilds.Kept{CX: n.CX, CY: n.CY, Chunk: n.Chunk}
	}
	c, err := wilds.GenerateV3(Epoch(e), int(cx), int(cy), k)
	if err != nil {
		return nil, err
	}
	return wilds.ToProto(c, e.Id), nil
}

// Glimpses reads every chunk from one world (wilds.Glimpses).
func (V3) Glimpses(e *contract.WildsEpoch, at []chunks.ChunkXY) ([]chunks.Glimpse, error) {
	xy := make([][2]int, len(at))
	for i, c := range at {
		xy[i] = [2]int{int(c.CX), int(c.CY)}
	}
	out := make([]chunks.Glimpse, len(at))
	for i, g := range wilds.Glimpses(Epoch(e), xy) {
		out[i] = chunks.Glimpse{Land: g.Land, River: g.River}
	}
	return out, nil
}

func (V3) Rumour(e *contract.WildsEpoch) (chunks.Rumour, bool, error) {
	if e.Kind != wilds.EpochWick {
		return chunks.Rumour{}, false, nil
	}
	p, ok := wilds.Rumour(Epoch(e))
	if !ok {
		return chunks.Rumour{}, false, nil
	}
	return chunks.Rumour{
		Place: p.Place.ID, Kind: p.Place.Kind, Landmark: p.Place.Landmark,
		CX: int32(p.Place.CX), CY: int32(p.Place.CY), Site: p.Site,
		TX: uint32(p.SiteTX), TY: uint32(p.SiteTY),
		Compass: p.Compass, Ring: p.Ring, PastRiver: p.PastRiver,
	}, true, nil
}
