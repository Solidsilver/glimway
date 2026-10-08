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
	"glimway/server/internal/store"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"
)

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
	Cleared     [][2]int          `json:"cleared"`
	Stumps      [][2]int          `json:"stumps"`
	Plants      []homePlantView   `json:"plants"`
	PostsBought int               `json:"postsBought"`
	NextPost    map[string]int    `json:"nextPost"`
	Outdoor     content.HomeGrid  `json:"outdoor"`
	Indoor      *content.HomeGrid `json:"indoor"`
	Items       []homeInstance    `json:"items"`
}

type homeRequest struct {
	Mutation
	Key      string          `json:"key"`
	Progress json.RawMessage `json:"progress,omitempty"`
	ItemDef  string          `json:"itemDef,omitempty"`
	ItemID   string          `json:"itemId,omitempty"`
	Tier     *int            `json:"tier,omitempty"`
	Scene    string          `json:"scene,omitempty"`
	X        *int            `json:"x,omitempty"`
	Y        *int            `json:"y,omitempty"`
	Rotation *int            `json:"rotation,omitempty"`
	Name     *string         `json:"name,omitempty"`
	Gate     *int            `json:"gate,omitempty"`
	To       string          `json:"to,omitempty"`
	HomeID   string          `json:"homeId,omitempty"`
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
	var req homeRequest
	if err := decode(w, r, &req); err != nil {
		return err
	}
	return a.keyedMutation(w, r, req.Mutation, req.Key, req, req.Progress, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
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
			err = a.claim(ctx, tx, s, req, member, now)
		case "joint":
			status, err = a.joint(ctx, tx, s, req, now)
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
				err = upgradeHome(ctx, tx, s, h, req, now)
			case "buy":
				instanceID, err = buyItem(ctx, tx, s, h, req, now)
			case "place", "move", "remove":
				instanceID, err = arrange(ctx, tx, s, h, op, req, now)
			case "clear":
				err = clearTile(ctx, tx, s, h, req, now)
			case "invite":
				status, err = invite(ctx, tx, s, h, req, now)
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
		return struct {
			Home      *homeView      `json:"home"`
			Materials map[string]int `json:"materials"`
			ItemID    string         `json:"itemId,omitempty"`
			Status    string         `json:"status,omitempty"`
		}{home, m, instanceID, status}, nil
	})
}
