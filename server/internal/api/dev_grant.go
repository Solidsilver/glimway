//go:build dev

package api

import (
	"encoding/json"
	"errors"
	"glimway/content"
	"glimway/server/internal/store"
	"net/http"
	"strconv"
)

// Dev mode (local playtesting only): POST /api/dev/grant gives the
// signed-in account Glimway's own things — embers, materials, items,
// tools, recipe pages, home goods — through the same store paths as real
// grants, each with its ledger row ("dev-grant"). Nothing from Habitica:
// only ids in content/items.json and content/homestead.json (and "embers")
// are grantable; anything else is refused. This file is compiled only into
// `-tags dev` builds, and the route is mounted by the dev build of the
// server command (server/cmd/glimway-server/dev_routes.go), for callers on
// the same machine only.

// DevGrantPath is the route's path.
const DevGrantPath = "/api/dev/grant"

// Embers is the grant id for embers (not an item).
const devEmbers = "embers"

// Caps per grant, and per request.
const (
	devMaxStack    = 9999
	devMaxEmbers   = 100000
	devMaxOneByOne = 20 // tools and home goods are made one at a time
	devMaxGrants   = 64
)

type devGrant struct {
	ID  string `json:"id"`
	Qty int    `json:"qty"`
}

type devGranted struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Qty  int    `json:"qty"`
}

// devGrantKind says what a grant id is and how many may be given at once,
// or refuses it: only Glimway's own content tables, never anything else.
func devGrantKind(id string) (kind string, max int, err error) {
	if id == devEmbers {
		return "embers", devMaxEmbers, nil
	}
	if d, ok := content.ItemFor(id); ok {
		switch content.ItemAssetKind(d) {
		case "material", "item":
			return content.ItemAssetKind(d), devMaxStack, nil
		case "instance":
			return "instance", devMaxOneByOne, nil
		}
	}
	if _, ok := content.HomeItemFor(id); ok {
		return "decoration", devMaxOneByOne, nil
	}
	return "", 0, fail(400, "invalid-asset")
}

// DevGrant serves POST /api/dev/grant: {"grants": [{"id", "qty"}]}. The
// answer is the mixed shape every read has — {state, result} — so the
// client adopts the new state like any other answer.
func (a *Server) DevGrant(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Glimway-Now", strconv.FormatInt(a.Config.Now().Unix(), 10))
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := a.devGrant(w, r); err != nil {
		problem(w, err)
	}
}

func (a *Server) devGrant(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Grants []devGrant `json:"grants"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil || len(req.Grants) == 0 || len(req.Grants) > devMaxGrants {
		return fail(400, "invalid-json")
	}
	// Validate everything before anything is given.
	kinds := make([]string, len(req.Grants))
	for i, g := range req.Grants {
		kind, max, err := devGrantKind(g.ID)
		if err != nil {
			return err
		}
		if g.Qty < 1 || g.Qty > max {
			return fail(400, "invalid-quantity")
		}
		kinds[i] = kind
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.Config.Now().Unix()
	out := []devGranted{}
	for i, g := range req.Grants {
		switch kinds[i] {
		case "embers":
			err = store.Credit(ctx, tx, &s, g.Qty, 0, "dev-grant", devEmbers, nil, now)
		case "material", "item":
			err = itemChange(ctx, tx, &s, g.ID, g.Qty, "dev-grant", g.ID, now)
		case "instance":
			def, _ := content.ItemFor(g.ID)
			for n := 0; n < g.Qty && err == nil; n++ {
				if _, err = newInstance(ctx, tx, def, instanceAt{"pack", s.AccountID}, "", -1, now); err == nil {
					err = currency(ctx, tx, s.AccountID, content.StackCurrency(def.GetId()), 1, "dev-grant", g.ID, now)
				}
			}
		case "decoration":
			for n := 0; n < g.Qty && err == nil; n++ {
				var id string
				if id, err = store.Random(); err == nil {
					if _, err = tx.ExecContext(ctx, "INSERT INTO homestead_items(id,item_def,location,account_id) VALUES(?,?,'inventory',?)", id, g.ID, s.AccountID); err == nil {
						err = currency(ctx, tx, s.AccountID, "decoration:"+g.ID, 1, "dev-grant", id, now)
					}
				}
			}
		default:
			err = errors.New("dev grant: unknown kind")
		}
		if err != nil {
			return err
		}
		out = append(out, devGranted{ID: g.ID, Kind: kinds[i], Qty: g.Qty})
		a.Config.Logger.Printf("dev grant account=%s id=%s kind=%s qty=%d", s.AccountID, g.ID, kinds[i], g.Qty)
	}
	if err = a.Config.State.Persist(ctx, tx, &s, now); err != nil {
		return err
	}
	return a.finishRead(w, r, tx, s, struct {
		Granted []devGranted `json:"granted"`
	}{out})
}
