package wilds

// A generated chunk's shape (generator v3, gen_v3.go): tiles, story sites,
// the chunk itself, its season's Mark, and the spacing rules entities and
// sites keep.

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"glimway/content"
)

// ErrGeneratorUnavailable: the epoch names a generator version this code
// doesn't have (the server answers `generator-unavailable`).
var ErrGeneratorUnavailable = errors.New("wilds: generator unavailable")

// Tile is a tile position inside a chunk.
type Tile struct {
	TX int `json:"tx"`
	TY int `json:"ty"`
}

// SiteKind names a story site (src/lib/wilds/outer.ts):
//   - echo: a phantom camp where an Echo of the Six can wait (outer)
//   - given: where the outer Wilds give a text back, by the way home (outer entry)
//   - cairn: the Amberwash forage cairn (outer)
//   - nest: a dead iron-oak with a jackdaw's nest (outer)
//   - reeds: a backwater of the Wend, with a still pool two tiles north (outer)
//   - plank: a plank half-buried where the bridge tore (the Tangle's crossing)
type SiteKind string

const (
	SiteEcho  SiteKind = "echo"
	SiteGiven SiteKind = "given"
	SiteCairn SiteKind = "cairn"
	SiteNest  SiteKind = "nest"
	SiteReeds SiteKind = "reeds"
	SitePlank SiteKind = "plank"
)

// Site is a story site's geometry: never who or what waits there for a
// player. ID is stable within the epoch: the kind, or "echo:<n>".
type Site struct {
	ID   string   `json:"id"`
	Kind SiteKind `json:"kind"`
	CX   int      `json:"cx"`
	CY   int      `json:"cy"`
	TX   int      `json:"tx"`
	TY   int      `json:"ty"`
}

// Chunk is one generated chunk. Ground and Solid are row-major,
// cell i = ty*Size + tx.
type Chunk struct {
	CX               int         `json:"cx"`
	CY               int         `json:"cy"`
	GeneratorVersion int         `json:"generatorVersion"`
	Size             int         `json:"size"`
	Ground           []Ground    `json:"ground"`
	Solid            []bool      `json:"solid"`
	Decor            []Decor     `json:"decor"`
	Sites            []Site      `json:"sites"`
	Entities         []Entity    `json:"entities"`
	Look             string      `json:"look"`             // "tangle" | "outer"
	Mark             string      `json:"mark"`             // the season's Mark for the outer look; "" when permanent
	Tier             int         `json:"tier,omitempty"`   // wilds.Tier
	Land             string      `json:"land,omitempty"`   // the land at the centre tile (Glimpse's sample)
	Places           []PlaceMark `json:"places,omitempty"` // places whose landmark stands here
}

// Walkable is true for an in-chunk tile that isn't solid.
func (c *Chunk) Walkable(x, y int) bool {
	return x >= 0 && y >= 0 && x < c.Size && y < c.Size && !c.Solid[y*c.Size+x]
}

// seasonMark is the Mark an outer season ("t:<startsAt>:<endsAt>") falls
// in, or "" for the permanent season "0".
func seasonMark(season string) (string, error) {
	if season == "0" {
		return "", nil
	}
	parts := strings.Split(season, ":")
	if len(parts) == 3 && parts[0] == "t" {
		start, err1 := strconv.ParseInt(parts[1], 10, 64)
		end, err2 := strconv.ParseInt(parts[2], 10, 64)
		if err1 == nil && err2 == nil && end > start {
			return content.CalendarAt(content.CalendarRules, start).Mark, nil
		}
	}
	return "", fmt.Errorf("wilds: bad season %q", season)
}

const (
	entityMargin  = 3 // entities keep this far from the chunk edge
	entityClear   = 3 // ... and from exits and the spawn
	entitySpacing = 4 // ... and from each other (Chebyshev), relaxed when crowded
)

func cheb(dx, dy int) int { return max(abs(dx), abs(dy)) }

type siteSlot struct {
	id     string
	kind   SiteKind
	cx, cy int
}

const (
	siteMargin  = 4 // sites keep this far from the chunk edge
	siteSpacing = 5 // ... and from each other (Chebyshev)
	reedsMinTY  = 6 // a reed pool sits two tiles north of its site
)
