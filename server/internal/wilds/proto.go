package wilds

import (
	"slices"

	contract "glimway/server/internal/gen/glimway/v1"
)

// Realm is the realm every region lies in today (the open map adds more).
const Realm = "hearthwick"

var siteKinds = map[SiteKind]contract.SiteKind{
	SiteEcho:  contract.SiteKind_SITE_KIND_ECHO,
	SiteCairn: contract.SiteKind_SITE_KIND_CAIRN,
	SiteNest:  contract.SiteKind_SITE_KIND_NEST,
	SitePlank: contract.SiteKind_SITE_KIND_PLANK,
	SiteGiven: contract.SiteKind_SITE_KIND_GIVEN,
	SiteReeds: contract.SiteKind_SITE_KIND_REEDS,
}

// ProtoSiteKind is the wire value of a site kind.
func ProtoSiteKind(k SiteKind) contract.SiteKind { return siteKinds[k] }

// ToProto packs a generated chunk as the stored and served WildsChunk:
// ground as palette nibbles, solid as bits, decor as parallel arrays with
// two flag bits per piece (flip, overhang), layer 0.
func ToProto(c Chunk, epochID string) *contract.WildsChunk {
	out := &contract.WildsChunk{
		EpochId:          epochID,
		Region:           c.RegionID,
		Realm:            Realm,
		Cx:               int32(c.CX),
		Cy:               int32(c.CY),
		GeneratorVersion: uint32(c.GeneratorVersion),
		Size:             uint32(c.Size),
		Spawn:            &contract.Tile{Tx: uint32(c.Spawn.TX), Ty: uint32(c.Spawn.TY)},
		Look:             c.Look,
		Mark:             c.Mark,
	}
	var palette []Ground
	for _, g := range c.Ground {
		if !slices.Contains(palette, g) {
			palette = append(palette, g)
		}
	}
	slices.Sort(palette)
	index := map[Ground]byte{}
	for i, g := range palette {
		index[g] = byte(i)
		out.Palette = append(out.Palette, g.String())
	}
	out.Ground = make([]byte, len(c.Ground)/2)
	for i, g := range c.Ground {
		out.Ground[i/2] |= index[g] << (4 * (i % 2))
	}
	out.Solid = make([]byte, len(c.Solid)/8)
	for i, s := range c.Solid {
		if s {
			out.Solid[i/8] |= 1 << (i % 8)
		}
	}
	for _, e := range c.Exits {
		out.Exits = append(out.Exits, &contract.Exit{
			Tx: uint32(e.TX), Ty: uint32(e.TY), Tw: uint32(e.TW), Th: uint32(e.TH),
			Dir: contract.Dir(e.Dir + 1), To: e.To,
			Entry: &contract.Tile{Tx: uint32(e.Entry.TX), Ty: uint32(e.Entry.TY)},
		})
	}
	d := &contract.DecorList{Flags: make([]byte, (len(c.Decor)+3)/4)}
	kinds := map[DecorKind]uint32{}
	for i, p := range c.Decor {
		k, ok := kinds[p.Kind]
		if !ok {
			k = uint32(len(d.Kinds))
			kinds[p.Kind] = k
			d.Kinds = append(d.Kinds, p.Kind.String())
		}
		d.Kind = append(d.Kind, k)
		d.Tx = append(d.Tx, uint32(p.TX))
		d.Ty = append(d.Ty, uint32(p.TY))
		d.Ox = append(d.Ox, int32(p.OX))
		d.Oy = append(d.Oy, int32(p.OY))
		d.Variant = append(d.Variant, uint32(p.Variant))
		if p.Flip {
			d.Flags[i/4] |= 1 << (2 * (i % 4))
		}
		if p.Overhang {
			d.Flags[i/4] |= 2 << (2 * (i % 4))
		}
	}
	out.Decor = d
	for _, s := range c.Sites {
		out.Sites = append(out.Sites, &contract.StorySite{Id: s.ID, Kind: siteKinds[s.Kind], Tx: uint32(s.TX), Ty: uint32(s.TY)})
	}
	for _, e := range c.Entities {
		out.Entities = append(out.Entities, &contract.WildsEntity{
			Id: e.ID, Kind: e.Kind, Tx: uint32(e.TX), Ty: uint32(e.TY),
			Enemies: slices.Clone(e.Enemies), Material: e.Material, Tier: uint32(e.Tier), Poi: e.POI,
		})
	}
	return out
}

// EntityFromProto reads a stored entity back for loot rolls.
func EntityFromProto(e *contract.WildsEntity) Entity {
	return Entity{
		ID: e.Id, Kind: e.Kind, TX: int(e.Tx), TY: int(e.Ty),
		Enemies: slices.Clone(e.Enemies), Material: e.Material, Tier: int(e.Tier), POI: e.Poi,
	}
}

// Walkable reads a packed chunk's solid bit (false outside the chunk).
func Walkable(c *contract.WildsChunk, tx, ty int) bool {
	S := int(c.Size)
	if tx < 0 || ty < 0 || tx >= S || ty >= S {
		return false
	}
	i := ty*S + tx
	return c.Solid[i/8]&(1<<(i%8)) == 0
}
