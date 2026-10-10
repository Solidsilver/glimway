package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/coder/websocket"
	contract "glimway/server/internal/gen/glimway/v2"
	profiles "glimway/server/internal/profile"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/wrapperspb"
	"slices"
	"time"
)

// Read-only authentication: presence never slides sessions, touches leases,
// changes revisions or writes progress. HTTP play/progress retains that role.
func (a *Server) presenceIdentity(ctx context.Context, session string, withAvatar bool) (presenceIdentity, error) {
	var v presenceIdentity
	v.Session = session
	var source string
	var lease sql.NullString
	var levelMark float64
	var classMark string
	now := a.Config.Now().Unix()
	err := a.Store.DB.QueryRowContext(ctx, `SELECT p.account_id,p.world_id,p.display_name,p.profile_source,p.lease_id,x.level_mark,COALESCE(x.class_mark,'') FROM sessions s JOIN sign_ins i ON i.account_id=s.account_id AND i.method='habitica' JOIN allowlist l ON l.habitica_id=i.subject JOIN players p ON p.account_id=s.account_id JOIN sync_baselines x ON x.account_id=p.account_id WHERE s.id_hash=? AND s.expires_at>? AND s.created_at>?`, session, now, now-int64(SessionTTL.Seconds())).Scan(&v.ID, &v.World, &v.Name, &source, &lease, &levelMark, &classMark)
	if err == sql.ErrNoRows {
		return v, fail(401, "unauthorized")
	}
	if err != nil {
		return v, err
	}
	if !lease.Valid {
		return v, fail(409, "superseded")
	}
	v.Lease = lease.String
	v.Name = capDonor(v.Name)
	// The profile is the account's state at auth (4.5): the craft and the
	// level mark gate casts, the avatar draws the hero.
	p, err := profiles.For(ctx, a.Store.DB, profiles.Account{ID: v.ID, Source: source})
	if err != nil {
		return v, err
	}
	if p != nil {
		v.Magic = presenceMagicFor(p, classMark, levelMark)
		if withAvatar {
			// The avatar carries the resolved companions, not the profile's
			// own picks (2.4), and the wardrobe's resolved look (4.4).
			c, err := store.CompanionsFor(ctx, a.Store.DB, v.ID, v.World, source, p)
			if err != nil {
				return v, err
			}
			avatar, err := visualAvatarFor(ctx, a.Store.DB, v.ID, *p, c)
			if err != nil {
				return v, err
			}
			v.Avatar = avatar
		}
	}
	return v, nil
}

// Query outside the hub lock. An error is unknown, not proof of revocation.
// A player who moved worlds under the same lease keeps the socket: the new
// world comes back for checkPresence to move them into its rooms, and the
// refreshed magic state with it.
func (a *Server) revalidatePresence(ctx context.Context, p *presencePeer, world string) (websocket.StatusCode, string, string, presenceMagic, error) {
	var fresh presenceMagic
	v, err := a.presenceIdentity(ctx, p.identity.Session, false)
	if err != nil {
		var f *failure
		if errors.As(err, &f) {
			if f.code == "superseded" {
				return presenceSuperseded, "superseded", "", fresh, nil
			}
			return presenceUnauthorized, "unauthorized", "", fresh, nil
		}
		return 0, "", "", fresh, err
	}
	if v.Lease != p.identity.Lease {
		return presenceSuperseded, "superseded", "", fresh, nil
	}
	if v.ID != p.identity.ID {
		return presenceUnauthorized, "unauthorized", "", fresh, nil
	}
	fresh = v.Magic
	if v.World != world {
		return 0, "", v.World, fresh, nil
	}
	return 0, "", "", fresh, nil
}

func (a *Server) checkPresence(parent context.Context, p *presencePeer) {
	h := a.presence
	h.mu.Lock()
	if h.peers[p.identity.ID] != p {
		h.mu.Unlock()
		return
	}
	generation := p.account.generation
	// The world can change (a move) under the hub lock: read it here.
	known := p.identity.World
	p.authCheck++
	check := p.authCheck
	h.mu.Unlock()
	ctx, cancel := context.WithTimeout(parent, millis(int(h.config.GetWriteTimeoutMs())))
	code, reason, world, magic, err := a.revalidatePresence(ctx, p, known)
	cancel()
	h.mu.Lock()
	defer h.mu.Unlock()
	// A newer play/logout or registration invalidates this query's result.
	if h.peers[p.identity.ID] != p || p.account.generation != generation || check < p.authApplied {
		return
	}
	p.authApplied = check
	if err != nil {
		if p.ctx.Err() != nil {
			return
		}
		p.authFailures++
		if p.authFailures < int(h.config.GetRevalidateFailures()) {
			return
		}
		code = websocket.StatusInternalError
		reason = "auth-unavailable"
	} else {
		p.authFailures = 0
	}
	if code != 0 {
		p.stop(code, reason)
		h.remove(p)
		return
	}
	p.identity.Magic = magic
	if world != "" && world != p.identity.World {
		h.moveWorld(p, world)
	}
}

// Bump before querying so in-flight first-message auth must re-check. Pointer
// and generation checks also prevent an older notification revoking a new peer.
func (a *Server) presenceChanged(id string) {
	h := a.presence
	h.mu.Lock()
	if account := h.accounts[id]; account != nil {
		account.generation++
	}
	p := h.peers[id]
	h.mu.Unlock()
	if p != nil {
		a.checkPresence(context.Background(), p)
	}
}

func (a *Server) presenceRevalidator(p *presencePeer) {
	ticker := time.NewTicker(millis(int(a.presence.config.GetRevalidateMs())))
	defer ticker.Stop()
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-ticker.C:
			a.checkPresence(p.ctx, p)
		}
	}
}

// presenceAvatar is glimway.v2's PresenceAvatar (this file owns its fields).
type presenceAvatarMsg = contract.PresenceAvatar

// visualAvatar is a player's presence avatar: what they look like, and the
// two companion fields the server alone writes (docs/design/crafts.md 2.4,
// 3.4) — selected_pet is the resolved follower (the chosen pet, or Habitica's
// current pet when nothing reads as chosen) and selected_mount is the mount
// that is out (absent when every mount is in its stall). `chosen` is the
// wardrobe's resolved choice (docs/design/purse-and-wardrobe.md 4.4): when
// any slot is chosen, the resolved look goes out as the costume map with
// use_costume true, and friends' screens draw it with today's code. Nothing
// chosen keeps the profile's own costume and its setting.
func visualAvatar(p rules.Profile, c store.Companions, chosen map[string]string) *contract.PresenceAvatar {
	// Asset keys are short ASCII identifiers. Reject controls/markup rather than
	// allowing JSON escaping to amplify a roster beyond the outgoing byte limit.
	assetKey := func(s string, limit int) bool {
		if len(s) > limit {
			return false
		}
		for _, c := range s {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
				return false
			}
		}
		return true
	}
	cleanMap := func(input map[string]*string) map[string]*structpb.Value {
		out := map[string]*structpb.Value{}
		for _, slot := range rules.Slots {
			v := input[slot]
			if v != nil && assetKey(*v, 128) {
				out[slot] = structpb.NewStringValue(*v)
			} else {
				out[slot] = structpb.NewNullValue()
			}
		}
		return out
	}
	visual := p.Appearance
	for _, v := range []*string{&visual.Size, &visual.Shirt, &visual.Skin, &visual.HairColor, &visual.Background} {
		if !assetKey(*v, 64) {
			*v = ""
		}
	}
	selected := func(v string) *wrapperspb.StringValue {
		if v == "" || !assetKey(v, 128) {
			return nil
		}
		return wrapperspb.String(v)
	}
	costume, useCostume := p.Costume, p.UseCostume
	if len(chosen) > 0 {
		costume, useCostume = rules.Look(p, chosen), true
	}
	return &contract.PresenceAvatar{
		Appearance: &contract.PresenceAppearance{Size: visual.Size, Shirt: visual.Shirt, Skin: visual.Skin, HairColor: visual.HairColor, HairStyle: visual.HairStyle, Background: visual.Background, HairBangs: visual.HairBangs, HairMustache: visual.HairMustache, HairBeard: visual.HairBeard, HairFlower: visual.HairFlower},
		Equipped:   cleanMap(p.Equipped), Costume: cleanMap(costume), UseCostume: useCostume, SelectedPet: selected(c.Follower(&p)), SelectedMount: selected(c.MountOut),
	}
}

// presenceRoom names a presence room: an area in a world.
type presenceRoom struct{ world, area string }

// homeRoom is a homestead land's room (the stable stands there).
func homeRoom(world string, gate int) presenceRoom {
	return presenceRoom{world: world, area: fmt.Sprintf("home:%d", gate)}
}

// avatarChanged tells the room what a companion change did to a player's
// avatar (2.4, 3.4): sent after a companions, mount-out or mount-home
// commit, so friends' screens update mid-visit. `also` are rooms that hear
// it too, wherever the player is: a mount going out or home empties or
// fills its bay, so the land its stable stands on hears it even when the
// owner is far away (or not connected), and whoever is there re-reads the
// stalls.
func (a *Server) avatarChanged(id string, avatar *presenceAvatarMsg, also ...presenceRoom) {
	h := a.presence
	h.mu.Lock()
	defer h.mu.Unlock()
	msg := &contract.PresenceAvatarChange{AccountId: id, Avatar: avatar}
	p := h.peers[id]
	if p != nil {
		p.identity.Avatar = avatar
		h.broadcast(p, msg)
	}
	if len(also) == 0 {
		return
	}
	b, err := encodePresence(msg)
	for _, other := range h.peers {
		if other == p || other.area == "" || p != nil && other.identity.World == p.identity.World && other.area == p.area {
			continue // the player, and their own room, which heard it above
		}
		if !slices.Contains(also, presenceRoom{world: other.identity.World, area: other.area}) {
			continue
		}
		if err != nil {
			other.stop(websocket.StatusInternalError, "internal")
			continue
		}
		h.enqueue(other, b)
	}
}
