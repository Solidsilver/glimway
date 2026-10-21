package wilds

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

// EncodeTerrainHeight is a lab-only byte codec, not a new game wire format.
// Two packed 2-bit planes hold structural tops and resolved kinds. Sorted sparse
// records carry exact signed edge heights, style and unambiguous face spans.
// Plan flags are included so storage measurements retain the access reservations.
func EncodeTerrainHeight(tiles []TerrainTile) []byte {
	if len(tiles) != 576 {
		panic("terrain height needs one 24x24 chunk")
	}
	out := make([]byte, 434)
	out[0] = 1
	out[1] = 24
	for i, t := range tiles {
		out[2+i/4] |= t.Top << uint((i%4)*2)
		out[146+i/4] |= t.Kind << uint((i%4)*2)
		flags := byte(0)
		if t.Protected {
			flags |= 1
		}
		if t.Route {
			flags |= 2
		}
		out[290+i/4] |= flags << uint((i%4)*2)
	}
	for i, t := range tiles {
		base := terrainFlat(t.Top)
		if t.Kind == TerrainFace || t.Kind == TerrainRock {
			base.Edges = [4]int16{-1, -1, -1, -1}
		}
		if t.Edges == base.Edges && !t.Built && t.Kind != TerrainFace && t.Kind != TerrainRamp {
			continue
		}
		out = binary.LittleEndian.AppendUint16(out, uint16(i))
		if t.Kind == TerrainFace {
			out = append(out, t.FaceTop, t.FaceRow, t.FaceRows)
			continue
		}
		flags := byte(0)
		if t.Built {
			flags |= 1
		}
		out = append(out, flags)
		for _, q := range t.Edges {
			out = binary.LittleEndian.AppendUint16(out, uint16(q))
		}
	}
	return out
}

func DecodeTerrainHeight(raw []byte) ([]TerrainTile, error) {
	if len(raw) < 434 || raw[0] != 1 || raw[1] != 24 {
		return nil, fmt.Errorf("invalid terrain height header")
	}
	out := make([]TerrainTile, 576)
	for i := range out {
		z := (raw[2+i/4] >> uint((i%4)*2)) & 3
		k := (raw[146+i/4] >> uint((i%4)*2)) & 3
		if k > TerrainRock {
			return nil, fmt.Errorf("unknown terrain kind")
		}
		out[i] = terrainFlat(z)
		out[i].Kind = k
		flags := (raw[290+i/4] >> uint((i%4)*2)) & 3
		out[i].Protected = flags&1 != 0
		out[i].Route = flags&2 != 0
		if k == TerrainFace || k == TerrainRock {
			out[i].Edges = [4]int16{-1, -1, -1, -1}
		}
	}
	seen := make([]bool, 576)
	last := -1
	for pos := 434; pos < len(raw); {
		if len(raw)-pos < 2 {
			return nil, fmt.Errorf("truncated override")
		}
		i := int(binary.LittleEndian.Uint16(raw[pos:]))
		pos += 2
		if i <= last || i >= 576 {
			return nil, fmt.Errorf("invalid override index")
		}
		last = i
		seen[i] = true
		t := &out[i]
		if t.Kind == TerrainFace {
			if len(raw)-pos < 3 {
				return nil, fmt.Errorf("truncated face")
			}
			t.FaceTop, t.FaceRow, t.FaceRows = raw[pos], raw[pos+1], raw[pos+2]
			pos += 3
			if t.FaceTop > 3 || t.FaceTop <= t.Top || t.FaceRows == 0 || t.FaceRows > 9 || t.FaceRows%3 != 0 || t.FaceRow >= t.FaceRows || TerrainWalkable(*t) {
				return nil, fmt.Errorf("invalid face span")
			}
			continue
		}
		if len(raw)-pos < 9 {
			return nil, fmt.Errorf("truncated edges")
		}
		flags := raw[pos]
		pos++
		if flags > 1 {
			return nil, fmt.Errorf("invalid style")
		}
		t.Built = flags == 1
		for d := 0; d < 4; d++ {
			q := int16(binary.LittleEndian.Uint16(raw[pos:]))
			pos += 2
			if q < -1 || q > 768 {
				return nil, fmt.Errorf("invalid edge height")
			}
			t.Edges[d] = q
		}
		if t.Kind != TerrainFace && !TerrainWalkable(*t) {
			return nil, fmt.Errorf("closed floor")
		}
	}
	for i, t := range out {
		if (t.Kind == TerrainFace || t.Kind == TerrainRamp) && !seen[i] {
			return nil, fmt.Errorf("missing geometric override")
		}
	}
	if !bytes.Equal(raw, EncodeTerrainHeight(out)) {
		return nil, fmt.Errorf("noncanonical terrain encoding")
	}
	return out, nil
}
