package wilds

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"strings"

	"glimway/content"
	"google.golang.org/protobuf/proto"
)

// The generator tests' shared helpers.

var updateGoldens = flag.Bool("update", false, "rewrite testdata/golden_v3.json from the generator")

// outerSeason is the wick season containing unix.
func outerSeason(unix int64) string {
	d := content.CalendarAt(content.CalendarRules, unix)
	return fmt.Sprintf("t:%d:%d", d.StartsAt, d.NextTurning)
}

// chunkHash is a short digest of a generated chunk's JSON, in the shape
// testdata/golden_v3.json was recorded in: v2's region, exits and spawn
// fields stood in Chunk then, always empty for v3, and a golden is never
// edited (a change is a new generator version).
func chunkHash(c Chunk) string {
	b, err := json.Marshal(struct {
		RegionID         string      `json:"regionId"`
		CX               int         `json:"cx"`
		CY               int         `json:"cy"`
		GeneratorVersion int         `json:"generatorVersion"`
		Size             int         `json:"size"`
		Ground           []Ground    `json:"ground"`
		Solid            []bool      `json:"solid"`
		Exits            []struct{}  `json:"exits"`
		Decor            []Decor     `json:"decor"`
		Sites            []Site      `json:"sites"`
		Entities         []Entity    `json:"entities"`
		Spawn            Tile        `json:"spawn"`
		Look             string      `json:"look"`
		Mark             string      `json:"mark"`
		Tier             int         `json:"tier,omitempty"`
		Land             string      `json:"land,omitempty"`
		Places           []PlaceMark `json:"places,omitempty"`
	}{"", c.CX, c.CY, c.GeneratorVersion, c.Size, c.Ground, c.Solid, nil, c.Decor, c.Sites, c.Entities, Tile{}, c.Look, c.Mark, c.Tier, c.Land, c.Places})
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:8])
}

// epochID is as long as a real one (store.Random: 64 hex characters).
var epochID = strings.Repeat("0", 64)

// encodeChunk is the stored and served bytes: the real WildsChunk message
// (entities included).
func encodeChunk(c Chunk) []byte {
	b, err := proto.Marshal(ToProto(c, epochID))
	if err != nil {
		panic(err)
	}
	return b
}

// chunkRawBudget: at most 6 KiB raw a chunk (open-map.md section 4).
const chunkRawBudget = 6 * 1024
