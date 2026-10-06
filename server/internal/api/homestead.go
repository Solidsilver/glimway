package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/land"
	"fingersnap/server/internal/rules"
	"fingersnap/server/internal/store"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Homesteads, second version (docs/hands-on-design.md section 1): each
// homestead is a gate on the Commons lane and its own map of wild land. Any
// number of players share one as equal members of its deed; a player belongs
// to at most one (homestead_members' primary key).

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
	PostsBought int               `json:"postsBought"`
	NextPost    map[string]int    `json:"nextPost"`
	Outdoor     content.HomeGrid  `json:"outdoor"`
	Indoor      *content.HomeGrid `json:"indoor"`
	Items       []homeInstance    `json:"items"`
}

const day = 86400

func desolate(vacantSince *int64, now int64) bool {
	return vacantSince != nil && now-*vacantSince >= int64(content.HomeRules.Desolation.DesolateAfterDays)*day
}

// memberOf is the caller's homestead, if any.
func memberOf(ctx context.Context, tx *sql.Tx, id string) (string, bool, error) {
	var home string
	err := tx.QueryRowContext(ctx, "SELECT homestead_id FROM homestead_members WHERE habitica_id=?", id).Scan(&home)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	return home, err == nil, err
}

// settleHomes applies the passage of time to a world's empty homesteads:
// past deedLostAfterDays the deed is lost, the land returns to unclaimed and
// everything left on it (placed pieces, the shared chest, cleared ground,
// pending invites) goes with it. Desolation itself is derived on read.
func settleHomes(ctx context.Context, tx *sql.Tx, world string, now int64) error {
	cutoff := now - int64(content.HomeRules.Desolation.DeedLostAfterDays)*day
	rows, err := tx.QueryContext(ctx, "SELECT id,gate FROM homesteads WHERE world_id=? AND vacant_since IS NOT NULL AND vacant_since<=? ORDER BY gate", world, cutoff)
	if err != nil {
		return err
	}
	type lost struct {
		id   string
		gate int
	}
	all := []lost{}
	for rows.Next() {
		var v lost
		if err = rows.Scan(&v.id, &v.gate); err != nil {
			rows.Close()
			return err
		}
		all = append(all, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, v := range all {
		for _, q := range []string{
			"DELETE FROM homestead_invites WHERE homestead_id=?",
			"DELETE FROM homestead_cleared WHERE homestead_id=?",
			"DELETE FROM item_stacks WHERE location='storage' AND owner=?",
			"DELETE FROM item_instances WHERE location='fitted' AND owner IN (SELECT id FROM item_instances WHERE location='storage' AND owner=?)",
			"DELETE FROM item_instances WHERE location='storage' AND owner=?",
			"DELETE FROM homestead_items WHERE homestead_id=?",
			"DELETE FROM homestead_members WHERE homestead_id=?",
			"DELETE FROM homesteads WHERE id=?",
		} {
			if _, err = tx.ExecContext(ctx, q, v.id); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO lost_gates(world_id,gate,lost_at) VALUES(?,?,?) ON CONFLICT(world_id,gate) DO UPDATE SET lost_at=excluded.lost_at", world, v.gate, now); err != nil {
			return err
		}
	}
	return nil
}

// gateCount is how many gates the lane shows: every claimed gate and at
// least SpareGates unclaimed ones.
func gateCount(ctx context.Context, tx *sql.Tx, world string) (int, error) {
	var n, top int
	if err := tx.QueryRowContext(ctx, "SELECT count(*),COALESCE(MAX(gate)+1,0) FROM homesteads WHERE world_id=?", world).Scan(&n, &top); err != nil {
		return 0, err
	}
	return max(top, n+content.HomeRules.Lane.SpareGates), nil
}

// deedPrice is what a player pays Silas for the deed to an unclaimed gate:
// the first deed is free, unless the land there was lost before.
func deedPrice(ctx context.Context, tx *sql.Tx, player, world string, gate int) (int, error) {
	var deeds, lost int
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE((SELECT deeds FROM player_deeds WHERE habitica_id=?),0),(SELECT count(*) FROM lost_gates WHERE world_id=? AND gate=?)", player, world, gate).Scan(&deeds, &lost); err != nil {
		return 0, err
	}
	if content.HomeRules.Deeds.FirstFree && deeds == 0 && lost == 0 {
		return 0, nil
	}
	return content.HomeRules.Deeds.Embers, nil
}
func addDeed(ctx context.Context, tx *sql.Tx, player string) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO player_deeds VALUES(?,1) ON CONFLICT(habitica_id) DO UPDATE SET deeds=deeds+1", player)
	return err
}

func members(ctx context.Context, tx *sql.Tx, home string) ([]homeMember, error) {
	rows, err := tx.QueryContext(ctx, "SELECT p.habitica_id,p.display_name FROM homestead_members m JOIN players p USING(habitica_id) WHERE m.homestead_id=? ORDER BY m.joined_at,p.habitica_id", home)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []homeMember{}
	for rows.Next() {
		var m homeMember
		if err = rows.Scan(&m.ID, &m.DisplayName); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func scanInstances(rows *sql.Rows, out []homeInstance) ([]homeInstance, error) {
	defer rows.Close()
	for rows.Next() {
		var v homeInstance
		if err := rows.Scan(&v.ID, &v.ItemDef, &v.Scene, &v.X, &v.Y, &v.Rotation, &v.Name); err != nil {
			return out, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// loadHome is a homestead as `caller` sees it: everything placed, and the
// caller's own pack decorations when they are a member (to set out).
func loadHome(ctx context.Context, tx *sql.Tx, id, caller string, now int64) (homeView, error) {
	h := homeView{ID: id, Outdoor: content.HomeRules.Outdoor(), Items: []homeInstance{}, Cleared: [][2]int{}}
	err := tx.QueryRowContext(ctx, "SELECT world_id,gate,tier,posts_bought,vacant_since FROM homesteads WHERE id=?", id).Scan(&h.WorldID, &h.Gate, &h.Tier, &h.PostsBought, &h.VacantSince)
	if err != nil {
		return h, err
	}
	h.Desolate = desolate(h.VacantSince, now)
	h.LandSeed = land.Seed(h.WorldID, h.Gate, content.HomeRules.Land)
	h.NextPost = content.HomeRules.PostCost(h.PostsBought)
	if h.Tier >= 1 {
		g := content.HomeRules.Indoor
		h.Indoor = &g
	}
	if h.Members, err = members(ctx, tx, id); err != nil {
		return h, err
	}
	h.Member = slices.ContainsFunc(h.Members, func(m homeMember) bool { return m.ID == caller })
	rows, err := tx.QueryContext(ctx, "SELECT x,y FROM homestead_cleared WHERE homestead_id=? ORDER BY y,x", id)
	if err != nil {
		return h, err
	}
	for rows.Next() {
		var c [2]int
		if err = rows.Scan(&c[0], &c[1]); err != nil {
			rows.Close()
			return h, err
		}
		h.Cleared = append(h.Cleared, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return h, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT id,item_def,scene,x,y,rotation,name FROM homestead_items WHERE homestead_id=? AND location='placed' ORDER BY id", id)
	if err != nil {
		return h, err
	}
	if h.Items, err = scanInstances(rows, h.Items); err != nil || !h.Member {
		return h, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT id,item_def,scene,x,y,rotation,name FROM homestead_items WHERE habitica_id=? AND location='inventory' ORDER BY id", caller)
	if err != nil {
		return h, err
	}
	h.Items, err = scanInstances(rows, h.Items)
	return h, err
}

// myHome is the caller's homestead view, or nil.
func myHome(ctx context.Context, tx *sql.Tx, caller string, now int64) (*homeView, error) {
	id, ok, err := memberOf(ctx, tx, caller)
	if err != nil || !ok {
		return nil, err
	}
	h, err := loadHome(ctx, tx, id, caller, now)
	return &h, err
}

func (a *Server) homeRead(w http.ResponseWriter, r *http.Request) error {
	raw, ok := strings.CutPrefix(r.URL.Path, "/api/homestead/gate/")
	gate, err := strconv.Atoi(raw)
	if !ok || err != nil || gate < 0 || strconv.Itoa(gate) != raw {
		return fail(404, "not-found")
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.Config.Now().Unix()
	if s.SaveOrigin == nil {
		return fail(409, "origin-required")
	}
	if err = settleHomes(ctx, tx, s.WorldID, now); err != nil {
		return err
	}
	n, err := gateCount(ctx, tx, s.WorldID)
	if err != nil {
		return err
	}
	if gate >= n {
		return fail(404, "invalid-gate")
	}
	var home *homeView
	var id string
	err = tx.QueryRowContext(ctx, "SELECT id FROM homesteads WHERE world_id=? AND gate=?", s.WorldID, gate).Scan(&id)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == nil {
		h, err := loadHome(ctx, tx, id, s.HabiticaID, now)
		if err != nil {
			return err
		}
		home = &h
	}
	m, err := materials(ctx, tx, s.HabiticaID)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Gate      int            `json:"gate"`
		LandSeed  uint32         `json:"landSeed"`
		Home      *homeView      `json:"home"`
		Materials map[string]int `json:"materials"`
	}{s, gate, land.Seed(s.WorldID, gate, content.HomeRules.Land), home, m})
}

type gateView struct {
	Gate     int          `json:"gate"`
	HomeID   *string      `json:"homeId"`
	Names    []string     `json:"names"`
	Members  []homeMember `json:"members"`
	Tier     int          `json:"tier"`
	Desolate bool         `json:"desolate"`
	Mine     bool         `json:"mine"`
	Price    *int         `json:"price"`
}
type person struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type inviteView struct {
	HomeID          string `json:"homeId"`
	Gate            int    `json:"gate"`
	From            person `json:"from"`
	To              person `json:"to"`
	ExpiresAt       int64  `json:"expiresAt"`
	FromConfirmedAt *int64 `json:"fromConfirmedAt"`
	ToConfirmedAt   *int64 `json:"toConfirmedAt"`
}

func (a *Server) commons(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.Config.Now().Unix()
	if s.SaveOrigin == nil {
		return fail(409, "origin-required")
	}
	if err = settleHomes(ctx, tx, s.WorldID, now); err != nil {
		return err
	}
	n, err := gateCount(ctx, tx, s.WorldID)
	if err != nil {
		return err
	}
	mineID, _, err := memberOf(ctx, tx, s.HabiticaID)
	if err != nil {
		return err
	}
	gates := make([]gateView, n)
	for g := range gates {
		gates[g] = gateView{Gate: g, Names: []string{}, Members: []homeMember{}}
	}
	rows, err := tx.QueryContext(ctx, "SELECT id,gate,tier,vacant_since FROM homesteads WHERE world_id=? ORDER BY gate", s.WorldID)
	if err != nil {
		return err
	}
	type claimed struct {
		id          string
		gate, tier  int
		vacantSince *int64
	}
	all := []claimed{}
	for rows.Next() {
		var v claimed
		if err = rows.Scan(&v.id, &v.gate, &v.tier, &v.vacantSince); err != nil {
			rows.Close()
			return err
		}
		all = append(all, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	var mine *struct {
		HomeID string `json:"homeId"`
		Gate   int    `json:"gate"`
	}
	for _, v := range all {
		g := &gates[v.gate]
		id := v.id
		g.HomeID, g.Tier, g.Desolate, g.Mine = &id, v.tier, desolate(v.vacantSince, now), v.id == mineID
		if g.Members, err = members(ctx, tx, v.id); err != nil {
			return err
		}
		for _, m := range g.Members {
			g.Names = append(g.Names, m.DisplayName)
		}
		if g.Mine {
			mine = &struct {
				HomeID string `json:"homeId"`
				Gate   int    `json:"gate"`
			}{v.id, v.gate}
		}
	}
	for g := range gates {
		if gates[g].HomeID == nil {
			p, err := deedPrice(ctx, tx, s.HabiticaID, s.WorldID, g)
			if err != nil {
				return err
			}
			gates[g].Price = &p
		}
	}
	invites, err := invitesFor(ctx, tx, s.WorldID, s.HabiticaID, mineID, now)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Gates     []gateView   `json:"gates"`
		GateCount int          `json:"gateCount"`
		Mine      any          `json:"mine"`
		Invites   []inviteView `json:"invites"`
	}{s, gates, n, mine, invites})
}

// invitesFor lists unexpired invites to the caller or from their homestead.
func invitesFor(ctx context.Context, tx *sql.Tx, world, caller, home string, now int64) ([]inviteView, error) {
	rows, err := tx.QueryContext(ctx, `SELECT i.homestead_id,h.gate,i.from_id,f.display_name,i.to_id,t.display_name,i.expires_at,i.from_confirmed_at,i.to_confirmed_at
FROM homestead_invites i JOIN homesteads h ON h.id=i.homestead_id JOIN players f ON f.habitica_id=i.from_id JOIN players t ON t.habitica_id=i.to_id
WHERE h.world_id=? AND i.expires_at>? AND (i.to_id=? OR i.homestead_id=?) ORDER BY i.created_at,i.to_id`, world, now, caller, home)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []inviteView{}
	for rows.Next() {
		var v inviteView
		if err = rows.Scan(&v.HomeID, &v.Gate, &v.From.ID, &v.From.Name, &v.To.ID, &v.To.Name, &v.ExpiresAt, &v.FromConfirmedAt, &v.ToConfirmedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
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

// cleanPostName tidies a lantern post's name (src/lib/homestead.ts cleanPostName).
func cleanPostName(raw string) (string, bool) {
	name := strings.Join(strings.Fields(raw), " ")
	if name == "" || !utf8.ValidString(name) || utf8.RuneCountInString(name) > content.HomeRules.LanternPosts.NameMax {
		return "", false
	}
	for _, c := range name {
		if unicode.IsControl(c) {
			return "", false
		}
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
		homeID, member, err := memberOf(ctx, tx, s.HabiticaID)
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
			if h, err = loadHome(ctx, tx, homeID, s.HabiticaID, now); err != nil {
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
		home, err := myHome(ctx, tx, s.HabiticaID, now)
		if err != nil {
			return nil, err
		}
		m, err := materials(ctx, tx, s.HabiticaID)
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

func (a *Server) claim(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req homeRequest, member bool, now int64) error {
	if member {
		return fail(409, "already-homesteaded")
	}
	n, err := gateCount(ctx, tx, s.WorldID)
	if err != nil {
		return err
	}
	if req.Gate == nil || *req.Gate < 0 || *req.Gate >= n {
		return fail(404, "invalid-gate")
	}
	gate := *req.Gate
	var taken int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM homesteads WHERE world_id=? AND gate=?", s.WorldID, gate).Scan(&taken); err != nil {
		return err
	}
	if taken > 0 {
		return fail(409, "gate-taken")
	}
	price, err := deedPrice(ctx, tx, s.HabiticaID, s.WorldID, gate)
	if err != nil {
		return err
	}
	ref := fmt.Sprintf("gate:%d", gate)
	if price > 0 {
		err = debitEmbers(ctx, tx, s, price, "homestead-deed", ref, now)
	} else {
		err = store.Credit(ctx, tx, s, 0, 0, "homestead-deed", ref, nil, now)
	}
	if err != nil {
		return err
	}
	id, err := store.Random()
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO homesteads(id,world_id,gate,claimed_at) VALUES(?,?,?,?)", id, s.WorldID, gate, now); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO homestead_members VALUES(?,?,?)", s.HabiticaID, id, now); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM lost_gates WHERE world_id=? AND gate=?", s.WorldID, gate); err != nil {
		return err
	}
	return addDeed(ctx, tx, s.HabiticaID)
}

func upgradeHome(ctx context.Context, tx *sql.Tx, s *store.Snapshot, h homeView, req homeRequest, now int64) error {
	tiers := content.HomeRules.Tiers
	if req.Tier == nil || *req.Tier != h.Tier+1 || *req.Tier >= len(tiers) || !tiers[*req.Tier].Purchasable {
		return fail(409, "tier-unavailable")
	}
	t := tiers[*req.Tier]
	if err := debitEmbers(ctx, tx, s, t.Embers, "homestead-upgrade", t.ID, now); err != nil {
		return err
	}
	if err := debitMaterials(ctx, tx, s, t.Materials, 1, "homestead-upgrade", t.ID, now); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "UPDATE homesteads SET tier=? WHERE id=?", t.Tier, h.ID)
	return err
}

func buyItem(ctx context.Context, tx *sql.Tx, s *store.Snapshot, h homeView, req homeRequest, now int64) (string, error) {
	def, ok := content.HomeItemFor(req.ItemDef)
	if !ok {
		return "", fail(400, "invalid-item")
	}
	if def.MinTier > h.Tier {
		return "", fail(409, "tier-required")
	}
	var err error
	if def.ID == content.HomeRules.LanternPosts.Item {
		// Each post costs more than the last (the homestead's count, not the buyer's).
		cost := content.HomeRules.PostCost(h.PostsBought)
		if err = checkMaterials(ctx, tx, s.HabiticaID, cost); err != nil {
			return "", err
		}
		if err = debitMaterials(ctx, tx, s, cost, 1, "homestead-buy", def.ID, now); err != nil {
			return "", err
		}
		_, err = tx.ExecContext(ctx, "UPDATE homesteads SET posts_bought=posts_bought+1 WHERE id=?", h.ID)
	} else if def.Embers > 0 {
		err = debitEmbers(ctx, tx, s, def.Embers, "homestead-buy", def.ID, now)
	} else {
		if err = checkMaterials(ctx, tx, s.HabiticaID, def.Materials); err != nil {
			return "", err
		}
		err = debitMaterials(ctx, tx, s, def.Materials, 1, "homestead-buy", def.ID, now)
	}
	if err != nil {
		return "", err
	}
	id, err := store.Random()
	if err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO homestead_items(id,item_def,location,habitica_id) VALUES(?,?,'inventory',?)", id, def.ID, s.HabiticaID); err != nil {
		return "", err
	}
	return id, currency(ctx, tx, s.HabiticaID, "decoration:"+def.ID, 1, "homestead-buy", id, now)
}

// ground is a homestead's land as the server validates it.
type ground struct {
	land    land.Land
	cleared map[[2]int]bool
}

func groundOf(h homeView) ground {
	g := ground{land.Generate(h.LandSeed, content.HomeRules.Land), map[[2]int]bool{}}
	for _, c := range h.Cleared {
		g.cleared[c] = true
	}
	return g
}

type rect struct{ x, y, w, h int }

func (a rect) overlaps(b rect) bool {
	return a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y
}
func footprint(id string, rotation int) (int, int) {
	v, _ := content.HomeItemFor(id)
	w, h := v.Footprint[0], v.Footprint[1]
	if rotation == 90 || rotation == 270 {
		return h, w
	}
	return w, h
}
func placedRect(v homeInstance) (rect, bool) {
	if v.Scene == nil || v.X == nil || v.Y == nil || v.Rotation == nil {
		return rect{}, false
	}
	if _, ok := content.HomeItemFor(v.ItemDef); !ok {
		return rect{}, false
	}
	w, h := footprint(v.ItemDef, *v.Rotation)
	return rect{*v.X, *v.Y, w, h}, true
}

// lightsWithout: the home's own light and every placed post but `except`.
func lightsWithout(items []homeInstance, except string) []land.Light {
	s := content.HomeRules.Land.StartLight
	out := []land.Light{{X: s.X, Y: s.Y, Radius: s.Radius}}
	for _, v := range items {
		if v.ItemDef == content.HomeRules.LanternPosts.Item && v.ID != except && v.Scene != nil && *v.Scene == "outdoor" && v.X != nil && v.Y != nil {
			out = append(out, land.Light{X: *v.X, Y: *v.Y, Radius: content.HomeRules.LanternPosts.Radius})
		}
	}
	return out
}
func rectLit(lights []land.Light, r rect) bool {
	for y := r.y; y < r.y+r.h; y++ {
		for x := r.x; x < r.x+r.w; x++ {
			if !land.Lit(lights, x, y) {
				return false
			}
		}
	}
	return true
}

// everythingLit: every outdoor piece stands in light other than its own, so
// land never floats on a chain of posts back to nothing.
func everythingLit(items []homeInstance) bool {
	for _, v := range items {
		if v.Scene == nil || *v.Scene != "outdoor" {
			continue
		}
		if r, ok := placedRect(v); ok && !rectLit(lightsWithout(items, v.ID), r) {
			return false
		}
	}
	return true
}

func placedItems(h homeView) []homeInstance {
	out := []homeInstance{}
	for _, v := range h.Items {
		if v.Scene != nil {
			out = append(out, v)
		}
	}
	return out
}

// validatePlacement mirrors checkPlacement in src/lib/homestead.ts; the
// server owns the buildable area.
func validatePlacement(h homeView, item homeInstance, r homeRequest) error {
	def, ok := content.HomeItemFor(item.ItemDef)
	if !ok {
		return fail(400, "invalid-item")
	}
	if r.X == nil || r.Y == nil || r.Rotation == nil || !slices.Contains([]int{0, 90, 180, 270}, *r.Rotation) || !slices.Contains(def.Where, r.Scene) {
		return fail(400, "invalid-placement")
	}
	if h.Tier < def.MinTier || (r.Scene == "indoor" && h.Indoor == nil) {
		return fail(409, "tier-required")
	}
	grid, reserved := h.Outdoor, content.HomeRules.OutdoorReserved
	if r.Scene == "indoor" {
		grid, reserved = *h.Indoor, content.HomeRules.IndoorReserved
	}
	w, ht := footprint(def.ID, *r.Rotation)
	here := rect{*r.X, *r.Y, w, ht}
	if here.x < 0 || here.y < 0 || here.x > grid.Width-w || here.y > grid.Height-ht {
		return fail(409, "out-of-bounds")
	}
	// The home site, the gate path and the doorway are kept clear.
	for _, v := range reserved {
		if here.overlaps(rect{v.X, v.Y, v.W, v.H}) {
			return fail(409, "placement-overlap")
		}
	}
	placed := placedItems(h)
	for _, v := range placed {
		if v.ID == item.ID || *v.Scene != r.Scene {
			continue
		}
		if o, ok := placedRect(v); ok && here.overlaps(o) {
			return fail(409, "placement-overlap")
		}
	}
	if r.Scene != "outdoor" {
		return nil
	}
	g := groundOf(h)
	for y := here.y; y < here.y+here.h; y++ {
		for x := here.x; x < here.x+here.w; x++ {
			if !land.Buildable(g.land.Effective(g.cleared, x, y)) {
				return fail(409, "land-blocked")
			}
		}
	}
	if !rectLit(lightsWithout(placed, item.ID), here) {
		return fail(409, "unlit")
	}
	if def.ID == content.HomeRules.LanternPosts.Item {
		scene, x, y, rot := r.Scene, *r.X, *r.Y, *r.Rotation
		moved := append(slices.DeleteFunc(slices.Clone(placed), func(v homeInstance) bool { return v.ID == item.ID }), homeInstance{ID: item.ID, ItemDef: item.ItemDef, Scene: &scene, X: &x, Y: &y, Rotation: &rot})
		if !everythingLit(moved) {
			return fail(409, "post-holds-land")
		}
	}
	return nil
}

func arrange(ctx context.Context, tx *sql.Tx, s *store.Snapshot, h homeView, op string, req homeRequest, now int64) (string, error) {
	var item *homeInstance
	for i := range h.Items {
		if h.Items[i].ID == req.ItemID {
			item = &h.Items[i]
			break
		}
	}
	if item == nil {
		return "", fail(404, "item-not-owned")
	}
	if op == "place" && item.Scene != nil {
		return "", fail(409, "already-placed")
	}
	if (op == "move" || op == "remove") && item.Scene == nil {
		return "", fail(409, "not-placed")
	}
	var err error
	post := item.ItemDef == content.HomeRules.LanternPosts.Item
	switch op {
	case "remove":
		rest := slices.DeleteFunc(placedItems(h), func(v homeInstance) bool { return v.ID == item.ID })
		if post && !everythingLit(rest) {
			return "", fail(409, "post-holds-land")
		}
		// Whoever puts it away carries it.
		_, err = tx.ExecContext(ctx, "UPDATE homestead_items SET location='inventory',habitica_id=?,homestead_id=NULL,scene=NULL,x=NULL,y=NULL,rotation=NULL,name=NULL WHERE id=?", s.HabiticaID, item.ID)
		if err == nil {
			err = currency(ctx, tx, s.HabiticaID, "decoration:"+item.ItemDef, 1, "homestead-remove", item.ID, now)
		}
	case "place":
		var name any
		if post {
			n, ok := "", false
			if req.Name != nil {
				n, ok = cleanPostName(*req.Name)
			}
			if !ok {
				return "", fail(400, "name-required")
			}
			name = n
		}
		if err = validatePlacement(h, *item, req); err != nil {
			return "", err
		}
		_, err = tx.ExecContext(ctx, "UPDATE homestead_items SET location='placed',habitica_id=NULL,homestead_id=?,scene=?,x=?,y=?,rotation=?,name=? WHERE id=? AND location='inventory' AND habitica_id=?", h.ID, req.Scene, *req.X, *req.Y, *req.Rotation, name, item.ID, s.HabiticaID)
		if err == nil {
			err = currency(ctx, tx, s.HabiticaID, "decoration:"+item.ItemDef, -1, "homestead-place", item.ID, now)
		}
	case "move":
		if err = validatePlacement(h, *item, req); err != nil {
			return "", err
		}
		_, err = tx.ExecContext(ctx, "UPDATE homestead_items SET scene=?,x=?,y=?,rotation=? WHERE id=?", req.Scene, *req.X, *req.Y, *req.Rotation, item.ID)
		if err == nil {
			err = currency(ctx, tx, s.HabiticaID, "decoration:"+item.ItemDef, 0, "homestead-move", item.ID, now)
		}
	}
	return item.ID, err
}

func clearTile(ctx context.Context, tx *sql.Tx, s *store.Snapshot, h homeView, req homeRequest, now int64) error {
	if req.X == nil || req.Y == nil {
		return fail(400, "invalid-placement")
	}
	x, y := *req.X, *req.Y
	g := groundOf(h)
	if x < 0 || y < 0 || x >= g.land.Width || y >= g.land.Height || !land.Clearable(g.land.At(x, y)) {
		return fail(409, "not-clearable")
	}
	if g.cleared[[2]int{x, y}] {
		return fail(409, "already-cleared")
	}
	if !land.Lit(lightsWithout(placedItems(h), ""), x, y) {
		return fail(409, "unlit")
	}
	if err := debitEmbers(ctx, tx, s, content.HomeRules.ClearTileEmbers, "homestead-clear", fmt.Sprintf("%s:%d,%d", h.ID, x, y), now); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "INSERT INTO homestead_cleared VALUES(?,?,?)", h.ID, x, y)
	return err
}

func invite(ctx context.Context, tx *sql.Tx, s *store.Snapshot, h homeView, req homeRequest, now int64) (string, error) {
	if req.To == "" || len(req.To) > 128 {
		return "", fail(404, "not-found")
	}
	if req.To == s.HabiticaID {
		return "", fail(400, "self-invite")
	}
	var world string
	err := tx.QueryRowContext(ctx, "SELECT world_id FROM players WHERE habitica_id=?", req.To).Scan(&world)
	if err == sql.ErrNoRows {
		return "", fail(404, "not-found")
	}
	if err != nil {
		return "", err
	}
	if world != s.WorldID {
		return "", fail(403, "world-access-denied")
	}
	if slices.ContainsFunc(h.Members, func(m homeMember) bool { return m.ID == req.To }) {
		return "", fail(409, "already-member")
	}
	expires := now + int64(content.HomeRules.JointDeed.InviteHours)*3600
	_, err = tx.ExecContext(ctx, `INSERT INTO homestead_invites(homestead_id,to_id,from_id,created_at,expires_at) VALUES(?,?,?,?,?)
ON CONFLICT(homestead_id,to_id) DO UPDATE SET from_id=excluded.from_id,created_at=excluded.created_at,expires_at=excluded.expires_at,from_confirmed_at=NULL,to_confirmed_at=NULL`, h.ID, req.To, s.HabiticaID, now, expires)
	return "invited", err
}

// atTable: connected to presence in this world, in the Commons, by Silas's table.
func (a *Server) atTable(world, id string) bool {
	t := content.HomeRules.Lane.SilasTable
	return a.presence != nil && a.presence.near(world, id, "commons", float64(t.X), float64(t.Y), float64(t.Radius))
}

// joint is one partner's signature on a joint deed. Both partners must stand
// at Silas's table; the second signature, within the confirm window of the
// first, amends the deed.
func (a *Server) joint(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req homeRequest, now int64) (string, error) {
	var from, world string
	var expires int64
	var fromAt, toAt *int64
	err := tx.QueryRowContext(ctx, "SELECT i.from_id,i.expires_at,i.from_confirmed_at,i.to_confirmed_at,h.world_id FROM homestead_invites i JOIN homesteads h ON h.id=i.homestead_id WHERE i.homestead_id=? AND i.to_id=?", req.HomeID, req.To).Scan(&from, &expires, &fromAt, &toAt, &world)
	if err == sql.ErrNoRows || (err == nil && (expires <= now || world != s.WorldID)) {
		return "", fail(404, "invite-not-found")
	}
	if err != nil {
		return "", err
	}
	other, column, otherAt := from, "to_confirmed_at", fromAt
	switch s.HabiticaID {
	case req.To:
	case from:
		other, column, otherAt = req.To, "from_confirmed_at", toAt
	default:
		return "", fail(404, "invite-not-found")
	}
	// The inviter must still be on the deed.
	fromHome, ok, err := memberOf(ctx, tx, from)
	if err != nil {
		return "", err
	}
	if !ok || fromHome != req.HomeID {
		return "", fail(404, "invite-not-found")
	}
	if !a.atTable(s.WorldID, s.HabiticaID) {
		return "", fail(409, "not-at-table")
	}
	if !a.atTable(s.WorldID, other) {
		return "", fail(409, "partner-not-at-table")
	}
	window := int64(content.HomeRules.JointDeed.ConfirmWindowSeconds)
	if otherAt == nil || now-*otherAt > window {
		_, err = tx.ExecContext(ctx, "UPDATE homestead_invites SET "+column+"=? WHERE homestead_id=? AND to_id=?", now, req.HomeID, req.To)
		return "waiting", err
	}
	if _, ok, err := memberOf(ctx, tx, req.To); err != nil {
		return "", err
	} else if ok {
		return "", fail(409, "already-homesteaded")
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO homestead_members VALUES(?,?,?)", req.To, req.HomeID, now); err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM homestead_invites WHERE homestead_id=? AND to_id=?", req.HomeID, req.To); err != nil {
		return "", err
	}
	if err = addDeed(ctx, tx, req.To); err != nil {
		return "", err
	}
	return "joined", store.Credit(ctx, tx, s, 0, 0, "homestead-joint", req.HomeID, nil, now)
}

// leave: the player takes their pack and personal chest (both are theirs
// already); placed pieces, posts and the shared chest stay. The last one out
// leaves the land vacant: desolate in a while, the deed lost after that.
func leave(ctx context.Context, tx *sql.Tx, s *store.Snapshot, h homeView, now int64) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM homestead_members WHERE habitica_id=?", s.HabiticaID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM homestead_invites WHERE homestead_id=? AND from_id=?", h.ID, s.HabiticaID); err != nil {
		return err
	}
	if len(h.Members) <= 1 {
		if _, err := tx.ExecContext(ctx, "UPDATE homesteads SET vacant_since=? WHERE id=?", now, h.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM homestead_invites WHERE homestead_id=?", h.ID); err != nil {
			return err
		}
	}
	return store.Credit(ctx, tx, s, 0, 0, "homestead-leave", h.ID, nil, now)
}

// checkHomeRest: resting at home means standing on your own homestead's map
// (or in its cottage, which saves as the map).
func checkHomeRest(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) error {
	gate := rules.HomeGate(s.State.Area)
	if gate < 0 {
		return fail(409, "not-at-own-plot")
	}
	if err := settleHomes(ctx, tx, s.WorldID, now); err != nil {
		return err
	}
	var mine int
	err := tx.QueryRowContext(ctx, "SELECT h.gate FROM homestead_members m JOIN homesteads h ON h.id=m.homestead_id WHERE m.habitica_id=?", s.HabiticaID).Scan(&mine)
	if err == sql.ErrNoRows || (err == nil && mine != gate) {
		return fail(409, "not-at-own-plot")
	}
	return err
}
