// Homesteads, second version (docs/hands-on-design.md section 1): each
// homestead is a gate on the Commons lane and its own map of wild land. Any
// number of players share one as equal members of its deed; a player belongs
// to at most one (homestead_members' primary key).

package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"
)

// The homestead views below are the domain's own shape: the workshop's read
// (workshop.go) still serves them directly, and the homestead routes project
// them onto the generated contract messages at the wire (homestead_wire.go).
type homeMember struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

type homeInstance struct {
	ID       string  `json:"id"`
	ItemDef  string  `json:"itemDef"`
	Scene    *string `json:"scene"`
	X        *int    `json:"x"`
	Y        *int    `json:"y"`
	Rotation *int    `json:"rotation"`
	Name     *string `json:"name"`
}

// homePlantView: a seed or sapling on the land, where it stands today
// (plantsOf); PlantedDay is the UTC day it went in.
type homePlantView struct {
	ID         string `json:"id"`
	ItemDef    string `json:"itemDef"`
	X          int    `json:"x"`
	Y          int    `json:"y"`
	PlantedAt  int64  `json:"plantedAt"`
	PlantedDay int64  `json:"plantedDay"`
	Lit        bool   `json:"lit"`
}

// homeLandChange: a gather that changed home land inside lamplight (the
// drift rule: a stump stays, open ground stays open). The client reads the
// home again when it sees one, so the next build of the land shows it.
type homeLandChange struct {
	Tile    [2]int `json:"tile"`
	Stump   bool   `json:"stump"`
	Cleared bool   `json:"cleared"`
}

type homeView struct {
	ID          string            `json:"id"`
	Gate        int               `json:"gate"`
	WorldID     string            `json:"worldId"`
	Tier        int               `json:"tier"`
	Members     []homeMember      `json:"members"`
	Member      bool              `json:"member"`
	Desolate    bool              `json:"desolate"`
	VacantSince *int64            `json:"vacantSince"`
	LandSeed    uint32            `json:"landSeed"`
	Cleared     tileList          `json:"cleared"`
	Stumps      tileList          `json:"stumps"`
	Plants      []homePlantView   `json:"plants"`
	PostsBought int               `json:"postsBought"`
	NextPost    map[string]int    `json:"nextPost"`
	Outdoor     content.HomeGrid  `json:"outdoor"`
	Indoor      *content.HomeGrid `json:"indoor"`
	Items       []homeInstance    `json:"items"`
}

// tileList decodes the homestead wire's tile pairs (now {"x":…,"y":…}
// objects) into the domain's [2]int pairs. The domain and the workshop's
// own answers keep emitting the pair arrays it always did.
type tileList [][2]int

func (t *tileList) UnmarshalJSON(b []byte) error {
	var raw []struct {
		X int `json:"x"`
		Y int `json:"y"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	out := make(tileList, 0, len(raw))
	for _, c := range raw {
		out = append(out, [2]int{c.X, c.Y})
	}
	*t = out
	return nil
}

// cleanPostName rejects Unicode controls before tidying whitespace, so tabs,
// newlines and NEL cannot disappear during normalization. Shared vectors live
// in content/vectors/post-names.json (src/lib/homestead.ts cleanPostName).
func cleanPostName(raw string) (string, bool) {
	for _, c := range raw {
		if unicode.IsControl(c) {
			return "", false
		}
	}
	name := strings.Join(strings.Fields(raw), " ")
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > content.HomeRules.LanternPosts.NameMax {
		return "", false
	}
	return name, true
}

func (a *Server) homeMutation(w http.ResponseWriter, r *http.Request) error {
	var req contract.HomesteadRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	return a.keyedOp(w, r, req.Op, req.Where, &req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if err := settleHomes(ctx, tx, s.WorldID, now); err != nil {
			return nil, err
		}
		op := strings.TrimPrefix(r.URL.Path, "/api/homestead/")
		homeID, member, err := memberOf(ctx, tx, s.AccountID)
		if err != nil {
			return nil, err
		}
		var instanceID, status string
		switch op {
		case "claim":
			err = a.claim(ctx, tx, s, &req, member, now)
		case "joint":
			status, err = a.joint(ctx, tx, s, &req, now)
		default:
			if !member {
				return nil, fail(409, "not-a-member")
			}
			var h homeView
			if h, err = loadHome(ctx, tx, homeID, s.AccountID, now); err != nil {
				return nil, err
			}
			switch op {
			case "upgrade":
				err = upgradeHome(ctx, tx, s, h, &req, now)
			case "buy":
				instanceID, err = buyItem(ctx, tx, s, h, &req, now)
			case "place", "move", "remove":
				instanceID, err = arrange(ctx, tx, s, h, op, &req, now)
			case "clear":
				err = clearTile(ctx, tx, s, h, &req, now)
			case "invite":
				status, err = invite(ctx, tx, s, h, &req, now)
			case "leave":
				err = leave(ctx, tx, s, h, now)
			default:
				err = fail(404, "not-found")
			}
		}
		if err != nil {
			return nil, err
		}
		home, err := myHome(ctx, tx, s.AccountID, now)
		if err != nil {
			return nil, err
		}
		m, err := materials(ctx, tx, s.AccountID)
		if err != nil {
			return nil, err
		}
		result := &contract.HomesteadResult{Materials: materialCountsProto(m), ItemId: instanceID, Status: status}
		if home != nil {
			result.Home = homeViewProto(*home)
		}
		return protoResult(result)
	})
}
