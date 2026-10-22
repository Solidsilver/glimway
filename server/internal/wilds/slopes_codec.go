package wilds

import (
	"bytes"
	"encoding/binary"
	"fmt"
)

// EncodeSlopeChunk is a lab envelope, not a protocol change: shared 25x25
// corners in 12 bits (4 coarse + 8 fractional), 2-bit kinds, intentional mask,
// then six-byte exact face spans in tile order. Uniform corners cost two bytes.
func EncodeSlopeChunk(tiles []SlopeTile) ([]byte, error) {
	if len(tiles) != 576 {
		return nil, fmt.Errorf("slope chunk needs 576 tiles")
	}
	corners := make([]uint16, 625)
	seen := make([]bool, 625)
	for i, t := range tiles {
		if t.Kind > SlopeCliff {
			return nil, fmt.Errorf("invalid kind")
		}
		if t.Kind == SlopeGround && SlopeGradientSquared(t.Corners) > SlopeWalkLimit*SlopeWalkLimit {
			return nil, fmt.Errorf("walkable gradient exceeds limit")
		}
		if t.Kind != SlopeCliff && (t.FaceTop != 0 || t.FaceBottom != 0 || t.FaceRow != 0 || t.FaceRows != 0) {
			return nil, fmt.Errorf("face metadata on non-cliff ground")
		}
		for k, off := range [4]int{0, 1, 26, 25} {
			j := (i/24)*25 + i%24 + off
			v := t.Corners[k]
			if v > 15*256+255 {
				return nil, fmt.Errorf("height exceeds 4-bit coarse range")
			}
			if seen[j] && corners[j] != v {
				return nil, fmt.Errorf("mismatched corner")
			}
			seen[j] = true
			corners[j] = v
		}
	}
	uniform := true
	for _, v := range corners {
		uniform = uniform && v == corners[0]
	}
	out := []byte{'S', 'L', 1, 0}
	if uniform {
		out[3] = 1
		out = binary.LittleEndian.AppendUint16(out, corners[0])
	} else {
		packed := make([]byte, (625*12+7)/8)
		for i, v := range corners {
			bit := i * 12
			for k := 0; k < 12; k++ {
				if v&(1<<k) != 0 {
					packed[(bit+k)/8] |= 1 << ((bit + k) % 8)
				}
			}
		}
		out = append(out, packed...)
	}
	kinds, flags := make([]byte, 144), make([]byte, 72)
	for i, t := range tiles {
		kinds[i/4] |= byte(t.Kind) << ((i % 4) * 2)
		if t.Unreachable {
			flags[i/8] |= 1 << (i % 8)
		}
	}
	out = append(out, kinds...)
	out = append(out, flags...)
	for _, t := range tiles {
		if t.Kind == SlopeCliff {
			if t.FaceTop <= t.FaceBottom || t.FaceTop > 4095 || t.FaceRows == 0 || t.FaceRow >= t.FaceRows || int(t.FaceRows) != (int(t.FaceTop-t.FaceBottom)*3+255)/256 {
				return nil, fmt.Errorf("invalid face span")
			}
			out = binary.LittleEndian.AppendUint16(out, t.FaceTop)
			out = binary.LittleEndian.AppendUint16(out, t.FaceBottom)
			out = append(out, t.FaceRow, t.FaceRows)
		}
	}
	return out, nil
}
func DecodeSlopeChunk(raw []byte) ([]SlopeTile, error) {
	if len(raw) < 4 || !bytes.Equal(raw[:3], []byte{'S', 'L', 1}) || raw[3] > 1 {
		return nil, fmt.Errorf("invalid slope envelope")
	}
	pos := 4
	corners := make([]uint16, 625)
	if raw[3] == 1 {
		if len(raw) < 6 {
			return nil, fmt.Errorf("short heights")
		}
		v := binary.LittleEndian.Uint16(raw[4:])
		for i := range corners {
			corners[i] = v
		}
		pos = 6
	} else {
		if len(raw) < pos+938 {
			return nil, fmt.Errorf("short heights")
		}
		for i := range corners {
			bit := i * 12
			for k := 0; k < 12; k++ {
				if raw[pos+(bit+k)/8]&(1<<((bit+k)%8)) != 0 {
					corners[i] |= 1 << k
				}
			}
		}
		pos += 938
	}
	if len(raw) < pos+216 {
		return nil, fmt.Errorf("short kinds")
	}
	kinds, flags := raw[pos:pos+144], raw[pos+144:pos+216]
	pos += 216
	tiles := make([]SlopeTile, 576)
	for i := range tiles {
		t := &tiles[i]
		t.Kind = SlopeKind((kinds[i/4] >> ((i % 4) * 2)) & 3)
		t.Unreachable = flags[i/8]&(1<<(i%8)) != 0
		for k, off := range [4]int{0, 1, 26, 25} {
			t.Corners[k] = corners[(i/24)*25+i%24+off]
		}
		if t.Kind == SlopeCliff {
			if len(raw) < pos+6 {
				return nil, fmt.Errorf("short faces")
			}
			t.FaceTop = binary.LittleEndian.Uint16(raw[pos:])
			t.FaceBottom = binary.LittleEndian.Uint16(raw[pos+2:])
			t.FaceRow, t.FaceRows = raw[pos+4], raw[pos+5]
			pos += 6
		}
	}
	canonical, err := EncodeSlopeChunk(tiles)
	if err != nil || pos != len(raw) || !bytes.Equal(raw, canonical) {
		return nil, fmt.Errorf("noncanonical slope envelope: %v", err)
	}
	return tiles, nil
}
