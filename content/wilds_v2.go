package content

// The v2 bridge (lane O-A, 0.8): generator v2 and today's server and client
// still play in two 3x3 regions, which contract 8 took out of wilds.json.
// Until lanes O-B, O-C and O-D replace them with the open map, each region
// is read off its footprint in `places`: the Tangle is "inner-1", the
// Whitequiet "outer-1", region-local chunk (x, y) is the footprint's
// (cx+x, cy+y), and the entry is the middle chunk, as it was. Delete this
// file with generator v2.

// WildsRegion is one of generator v2's regions. Its getters spell the ones
// the old generated message had, so v2's code reads it unchanged.
type WildsRegion struct {
	id, kind string
	place    *WildsPlace
}

func (r *WildsRegion) GetId() string        { return r.id }
func (r *WildsRegion) GetKind() string      { return r.kind }
func (r *WildsRegion) GetGridWidth() int32  { return r.place.GetWidth() }
func (r *WildsRegion) GetGridHeight() int32 { return r.place.GetHeight() }
func (r *WildsRegion) GetEntryX() int32     { return r.place.GetWidth() / 2 }
func (r *WildsRegion) GetEntryY() int32     { return r.place.GetHeight() / 2 }

// Place is the footprint the region is read off.
func (r *WildsRegion) Place() *WildsPlace { return r.place }

// WildsPlaceByID is the footprint with the id, or nil.
func WildsPlaceByID(id string) *WildsPlace {
	for _, p := range WildsRules.Places {
		if p.GetId() == id {
			return p
		}
	}
	return nil
}

// WildsV2Regions are generator v2's two regions, inner first.
var WildsV2Regions = []*WildsRegion{
	{id: "inner-1", kind: "inner", place: WildsPlaceByID("tangle")},
	{id: "outer-1", kind: "outer", place: WildsPlaceByID("whitequiet")},
}
