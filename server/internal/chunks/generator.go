package chunks

import (
	contract "glimway/server/internal/gen/glimway/v1"
)

// Generator makes the open map's land (generator v3, lane O-B; open-map.md
// 2.2). Everything it answers is a pure function of the epoch and the
// coordinates: the store calls Chunk once a chunk and epoch and keeps the
// blob, and the near read and the rumour call Glimpses and Rumour as often as
// they like, never storing anything.
type Generator interface {
	// Version is the generator version new epochs are made with.
	Version() int
	// Chunk makes the chunk (cx, cy) of the epoch. kept holds the stored
	// neighbours that lie in another, kept epoch (in 0.8 the Tangle's
	// chunks beside a wick chunk), whose edges the new chunk copies at the
	// seam (2.3). It is empty for a chunk with no such neighbour.
	Chunk(epoch *contract.WildsEpoch, cx, cy int32, kept []Kept) (*contract.WorldChunk, error)
	// Glimpses are chunks' main lands and whether the Wend crosses each,
	// from the lands and river passes alone (decision 22), for chunks past
	// the frontier that are never made: one answer per chunk, in order. A
	// batch, so the near read's ~16 cost one generator setup, not 16.
	Glimpses(epoch *contract.WildsEpoch, at []ChunkXY) ([]Glimpse, error)
	// Rumour is the wick epoch's one hidden find (decision 19): a place in a
	// new cell, never a footprint. ok is false when the epoch has none.
	Rumour(epoch *contract.WildsEpoch) (r Rumour, ok bool, err error)
}

// Kept is a stored neighbour in a kept epoch (wilds.Kept's twin): the
// chunk (CX, CY), one of the eight around the chunk being made.
type Kept struct {
	CX, CY int
	Chunk  *contract.WorldChunk
}

// ChunkXY is a chunk's signed coordinates.
type ChunkXY struct{ CX, CY int32 }

// Glimpse is what the veil lets through of a chunk past the frontier.
type Glimpse struct {
	Land  string
	River bool
}

// Rumour is the wick's hidden find (wilds.RumourPick's parts): the place
// (a place mark id), its kind and landmark decor kind, the chunk holding the
// find's site, the site's id ("rumour:<cx>:<cy>") and local tile, the
// compass word from the Commons gate (n ne e se s sw w nw), the ring
// (wilds.Ring of the landmark's chunk), and whether the Wend lies between
// the gate and the place.
type Rumour struct {
	Place, Kind, Landmark string
	CX, CY                int32
	Site                  string
	TX, TY                uint32
	Compass               string
	Ring                  int
	PastRiver             bool
}
