package api

import (
	"context"
	"database/sql"
	"errors"
	"github.com/coder/websocket"
	contract "glimway/server/internal/gen/glimway/v2"
	profiles "glimway/server/internal/profile"
	"glimway/server/internal/rules"
	"google.golang.org/protobuf/types/known/structpb"
	"google.golang.org/protobuf/types/known/wrapperspb"
	"time"
)

// Read-only authentication: presence never slides sessions, touches leases,
// changes revisions or writes progress. HTTP play/progress retains that role.
func (a *Server) presenceIdentity(ctx context.Context, session string, withAvatar bool) (presenceIdentity, error) {
	var v presenceIdentity
	v.Session = session
	var source string
	var lease sql.NullString
	now := a.Config.Now().Unix()
	err := a.Store.DB.QueryRowContext(ctx, `SELECT p.account_id,p.world_id,p.display_name,p.profile_source,p.lease_id FROM sessions s JOIN sign_ins i ON i.account_id=s.account_id AND i.method='habitica' JOIN allowlist l ON l.habitica_id=i.subject JOIN players p ON p.account_id=s.account_id WHERE s.id_hash=? AND s.expires_at>? AND s.created_at>?`, session, now, now-int64(SessionTTL.Seconds())).Scan(&v.ID, &v.World, &v.Name, &source, &lease)
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
	if withAvatar {
		p, err := profiles.For(ctx, a.Store.DB, profiles.Account{ID: v.ID, Source: source})
		if err != nil {
			return v, err
		}
		if p != nil {
			v.Avatar = visualAvatar(*p)
		}
	}
	return v, nil
}

// Query outside the hub lock. An error is unknown, not proof of revocation.
// A player who moved worlds under the same lease keeps the socket: the new
// world comes back for checkPresence to move them into its rooms.
func (a *Server) revalidatePresence(ctx context.Context, p *presencePeer, world string) (websocket.StatusCode, string, string, error) {
	v, err := a.presenceIdentity(ctx, p.identity.Session, false)
	if err != nil {
		var f *failure
		if errors.As(err, &f) {
			if f.code == "superseded" {
				return presenceSuperseded, "superseded", "", nil
			}
			return presenceUnauthorized, "unauthorized", "", nil
		}
		return 0, "", "", err
	}
	if v.Lease != p.identity.Lease {
		return presenceSuperseded, "superseded", "", nil
	}
	if v.ID != p.identity.ID {
		return presenceUnauthorized, "unauthorized", "", nil
	}
	if v.World != world {
		return 0, "", v.World, nil
	}
	return 0, "", "", nil
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
	ctx, cancel := context.WithTimeout(parent, millis(h.config.WriteTimeoutMs))
	code, reason, world, err := a.revalidatePresence(ctx, p, known)
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
		if p.authFailures < h.config.RevalidateFailures {
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
	ticker := time.NewTicker(millis(a.presence.config.RevalidateMs))
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

func visualAvatar(p rules.Profile) *contract.PresenceAvatar {
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
	selected := func(v *string) *wrapperspb.StringValue {
		if v == nil || !assetKey(*v, 128) {
			return nil
		}
		return wrapperspb.String(*v)
	}
	return &contract.PresenceAvatar{
		Appearance: &contract.PresenceAppearance{Size: visual.Size, Shirt: visual.Shirt, Skin: visual.Skin, HairColor: visual.HairColor, HairStyle: visual.HairStyle, Background: visual.Background, HairBangs: visual.HairBangs, HairMustache: visual.HairMustache, HairBeard: visual.HairBeard, HairFlower: visual.HairFlower},
		Equipped:   cleanMap(p.Equipped), Costume: cleanMap(p.Costume), UseCostume: p.UseCostume, SelectedPet: selected(p.SelectedPet), SelectedMount: selected(p.SelectedMount),
	}
}
