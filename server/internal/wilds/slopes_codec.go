package wilds

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

const SlopeWireVersion = 2

func validateSlopeSurface(s *SlopeSurface) error {
	if s == nil || s.W < 1 || s.H < 1 || s.W > 64 || s.H > 64 || len(s.Corners) != (s.W+1)*(s.H+1) || len(s.Ground) != s.W*s.H {
		return fmt.Errorf("invalid slope surface dimensions")
	}
	last := -1
	for _, o := range s.Overrides {
		if o.Tile <= last || o.Tile >= len(s.Ground) {
			return fmt.Errorf("overrides must have unique ascending tile indices")
		}
		last = o.Tile
		if o.Corners == s.gridCorners(o.Tile) || s.Ground[o.Tile].Discontinuity == 0 {
			return fmt.Errorf("override needs changed corners and an explicit discontinuity")
		}
	}
	for i, g := range s.Ground {
		if g.Kind > SlopeCliff || g.Discontinuity > 15 {
			return fmt.Errorf("invalid terrain kind or edge flags")
		}
		t := s.Tile(i)
		if g.Kind == SlopeGround && SlopeGradientSquared(t.Corners) > SlopeWalkLimit*SlopeWalkLimit {
			return fmt.Errorf("walkable gradient exceeds limit")
		}
		if g.Kind == SlopeCliff {
			if g.FaceTop <= g.FaceBottom || g.FaceRows == 0 || g.FaceRow >= g.FaceRows || int(g.FaceRows) != (int(g.FaceTop-g.FaceBottom)*3+255)/256 {
				return fmt.Errorf("invalid face span")
			}
		} else if g.FaceTop != 0 || g.FaceBottom != 0 || g.FaceRow != 0 || g.FaceRows != 0 {
			return fmt.Errorf("face metadata on non-cliff ground")
		}
		for _, d := range []int{1, 2} {
			x, y := i%s.W+terrainDX[d], i/s.W+terrainDY[d]
			if x >= s.W || y >= s.H {
				continue
			}
			j := y*s.W + x
			a, b := g.Discontinuity&(1<<d) != 0, s.Ground[j].Discontinuity&(1<<((d+2)%4)) != 0
			if a != b {
				return fmt.Errorf("unpaired internal discontinuity")
			}
			c, n := t.Corners, s.Tile(j).Corners
			match := c[1] == n[0] && c[2] == n[3]
			if d == 2 {
				match = c[3] == n[0] && c[2] == n[1]
			}
			if !match && !a {
				return fmt.Errorf("unflagged corner crack")
			}
		}
	}
	return nil
}

// EncodeSlopeChunk is a lab envelope, not a protocol change. Version 2 stores
// a shared Uint16 grid (or one uniform Uint16), packed kinds, sparse flag
// planes, sorted 10-byte per-tile four-corner overrides, and exact face spans.
// All geometry and edge flags are in field coordinates; cover is separate.
func EncodeSlopeChunk(s *SlopeSurface) ([]byte, error) {
	if err := validateSlopeSurface(s); err != nil {
		return nil, err
	}
	n := len(s.Ground)
	uniform := true
	for _, q := range s.Corners {
		uniform = uniform && q == s.Corners[0]
	}
	out := []byte{'S', 'L', SlopeWireVersion, byte(s.W), byte(s.H), 0}
	if uniform {
		out[5] = 1
		out = binary.LittleEndian.AppendUint16(out, s.Corners[0])
	} else {
		for _, q := range s.Corners {
			out = binary.LittleEndian.AppendUint16(out, q)
		}
	}
	kinds := make([]byte, (n+3)/4)
	planes := [6][]byte{}
	for i := range planes {
		planes[i] = make([]byte, (n+7)/8)
	}
	mask := byte(0)
	for i, g := range s.Ground {
		kinds[i/4] |= byte(g.Kind) << ((i % 4) * 2)
		bits := g.Discontinuity << 2
		if g.Unreachable {
			bits |= 1
		}
		if g.Kind == SlopeCliff {
			bits |= 2
		}
		for b := 0; b < 6; b++ {
			if bits&(1<<b) != 0 {
				planes[b][i/8] |= 1 << (i % 8)
				mask |= 1 << b
			}
		}
	}
	out = append(out, kinds...)
	out = append(out, mask)
	for b := 0; b < 6; b++ {
		if mask&(1<<b) != 0 {
			out = append(out, planes[b]...)
		}
	}
	out = binary.LittleEndian.AppendUint16(out, uint16(len(s.Overrides)))
	for _, o := range s.Overrides {
		out = binary.LittleEndian.AppendUint16(out, uint16(o.Tile))
		for _, q := range o.Corners {
			out = binary.LittleEndian.AppendUint16(out, q)
		}
	}
	for _, g := range s.Ground {
		if g.Kind == SlopeCliff {
			out = binary.LittleEndian.AppendUint16(out, g.FaceTop)
			out = binary.LittleEndian.AppendUint16(out, g.FaceBottom)
			out = append(out, g.FaceRow, g.FaceRows)
		}
	}
	return out, nil
}

func DecodeSlopeChunk(raw []byte) (*SlopeSurface, error) {
	if len(raw) < 6 || !bytes.Equal(raw[:3], []byte{'S', 'L', SlopeWireVersion}) || raw[3] == 0 || raw[3] > 64 || raw[4] == 0 || raw[4] > 64 || raw[5] > 1 {
		return nil, fmt.Errorf("invalid slope envelope")
	}
	s := &SlopeSurface{W: int(raw[3]), H: int(raw[4])}
	n := s.W * s.H
	s.Corners = make([]uint16, (s.W+1)*(s.H+1))
	s.Ground = make([]SlopeGroundData, n)
	pos := 6
	count := len(s.Corners)
	if raw[5] == 1 {
		count = 1
	}
	if len(raw) < pos+count*2 {
		return nil, fmt.Errorf("short corner grid")
	}
	for i := range s.Corners {
		j := i
		if raw[5] == 1 {
			j = 0
		}
		s.Corners[i] = binary.LittleEndian.Uint16(raw[pos+j*2:])
	}
	pos += count * 2
	kindBytes := (n + 3) / 4
	if len(raw) < pos+kindBytes+1 {
		return nil, fmt.Errorf("short kinds")
	}
	kinds := raw[pos : pos+kindBytes]
	pos += kindBytes
	mask := raw[pos]
	pos++
	if mask&0xc0 != 0 {
		return nil, fmt.Errorf("unknown flag plane")
	}
	bits := make([]byte, n)
	for b := 0; b < 6; b++ {
		if mask&(1<<b) == 0 {
			continue
		}
		nb := (n + 7) / 8
		if len(raw) < pos+nb {
			return nil, fmt.Errorf("short edge flags")
		}
		for i := range bits {
			if raw[pos+i/8]&(1<<(i%8)) != 0 {
				bits[i] |= 1 << b
			}
		}
		pos += nb
	}
	for i := range s.Ground {
		g := &s.Ground[i]
		g.Kind = SlopeKind((kinds[i/4] >> ((i % 4) * 2)) & 3)
		g.Unreachable = bits[i]&1 != 0
		g.Discontinuity = bits[i] >> 2
		if (bits[i]&2 != 0) != (g.Kind == SlopeCliff) {
			return nil, fmt.Errorf("cliff flag disagrees with ground kind")
		}
	}
	if len(raw) < pos+2 {
		return nil, fmt.Errorf("missing override count")
	}
	overrides := int(binary.LittleEndian.Uint16(raw[pos:]))
	pos += 2
	if overrides > n || len(raw) < pos+overrides*10 {
		return nil, fmt.Errorf("invalid override records")
	}
	for range overrides {
		o := SlopeCornerOverride{Tile: int(binary.LittleEndian.Uint16(raw[pos:]))}
		pos += 2
		for k := range o.Corners {
			o.Corners[k] = binary.LittleEndian.Uint16(raw[pos:])
			pos += 2
		}
		s.Overrides = append(s.Overrides, o)
	}
	for i := range s.Ground {
		g := &s.Ground[i]
		if g.Kind == SlopeCliff {
			if len(raw) < pos+6 {
				return nil, fmt.Errorf("short faces")
			}
			g.FaceTop = binary.LittleEndian.Uint16(raw[pos:])
			g.FaceBottom = binary.LittleEndian.Uint16(raw[pos+2:])
			g.FaceRow, g.FaceRows = raw[pos+4], raw[pos+5]
			pos += 6
		}
	}
	canonical, err := EncodeSlopeChunk(s)
	if err != nil {
		return nil, err
	}
	if pos != len(raw) || !bytes.Equal(raw, canonical) {
		return nil, fmt.Errorf("noncanonical slope envelope")
	}
	return s, nil
}
