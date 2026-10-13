package api

import (
	"context"
	"errors"
	"github.com/coder/websocket"
	"glimway/content"
	"glimway/server/internal/frontier"
	contract "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"google.golang.org/protobuf/proto"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// validPresenceRoom: an area, or a Wilds chunk's room "wilds:<cx>:<cy>"
// (signed, inside the frontier; open-map.md 2.4).
func validPresenceRoom(area string) bool {
	if validArea(area) {
		return area != wildsArea
	}
	_, _, ok := wildsRoomChunk(area)
	return ok
}

// wildsRoomChunk is the chunk a Wilds room names.
func wildsRoomChunk(room string) (cx, cy int, ok bool) {
	parts := strings.Split(room, ":")
	if len(parts) != 3 || parts[0] != wildsArea || len(room) > 64 {
		return 0, 0, false
	}
	x, err := strconv.Atoi(parts[1])
	if err != nil || strconv.Itoa(x) != parts[1] {
		return 0, 0, false
	}
	y, err := strconv.Atoi(parts[2])
	if err != nil || strconv.Itoa(y) != parts[2] || !frontier.Inside("", x, y) {
		return 0, 0, false
	}
	return x, y, true
}

// positionInsideFrontier: a Wilds world-pixel position's chunk is inside
// the frontier.
func positionInsideFrontier(world string, x, y float64) bool {
	tx, ty := wilds.TileOfPixel(x, y)
	cx, cy := wilds.ChunkOf(tx, ty)
	return frontier.Inside(world, cx, cy)
}

// sharedRoom: two rooms see each other. An area's room sees only itself; a
// Wilds chunk's room sees its own chunk's and its eight neighbours', so a
// client joins only the room of the chunk it stands in and still sees
// everyone in the 3x3 around it (open-map.md 2.4: one room a client).
func sharedRoom(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	if a == b {
		return true
	}
	ax, ay, ok1 := wildsRoomChunk(a)
	bx, by, ok2 := wildsRoomChunk(b)
	return ok1 && ok2 && intAbs(ax-bx) <= 1 && intAbs(ay-by) <= 1
}

func (a *Server) presenceSocket(w http.ResponseWriter, r *http.Request) error {
	if !sameOrigin(r, true) || len(r.URL.RawQuery) > 0 {
		return fail(403, "cross-origin")
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || len(cookie.Value) != 64 {
		return fail(401, "unauthorized")
	}
	session := store.Hash(cookie.Value)
	h := a.presence
	// Already-full sessions need no additional DB proof query.
	h.mu.Lock()
	sessionFull := h.sessions[session] >= int(h.config.GetMaxSessionConnections())
	h.mu.Unlock()
	if sessionFull {
		w.Header().Set("Retry-After", "5")
		return fail(429, "presence-session-limit")
	}
	ctx, cancel := context.WithTimeout(context.Background(), millis(int(a.presence.config.GetAuthTimeoutMs())))
	identity, err := a.presenceIdentity(ctx, session, false)
	cancel()
	if err != nil {
		return err
	}
	reservation, err := h.reserve(session, identity.ID)
	if err != nil {
		w.Header().Set("Retry-After", "5")
		return err
	}
	defer h.release(reservation)
	// net/http deadlines survive hijacking; network lifetimes are owned here.
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Time{})
	_ = controller.SetWriteDeadline(time.Time{})
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{presenceProtocol}})
	if err != nil {
		return nil
	}
	defer conn.CloseNow()
	if conn.Subprotocol() != presenceProtocol {
		_ = conn.Close(presenceReload, "reload-needed")
		return nil
	}
	h.mu.Lock()
	if h.closing {
		h.mu.Unlock()
		_ = conn.Close(websocket.StatusGoingAway, "server-shutdown")
		return nil
	}
	h.sockets[conn] = struct{}{}
	h.mu.Unlock()
	defer func() { h.mu.Lock(); delete(h.sockets, conn); h.mu.Unlock() }()
	conn.SetReadLimit(int64(int(h.config.GetMessageBytes())))
	ctx, cancel = context.WithTimeout(context.Background(), millis(int(h.config.GetAuthTimeoutMs())))
	typ, b, err := conn.Read(ctx)
	cancel()
	if err != nil {
		return nil
	}
	message, err := decodePresence(b)
	auth := message.GetAuth()
	if err != nil || typ != websocket.MessageBinary || auth == nil || len(auth.Lease) != 64 {
		_ = conn.Close(presenceUnauthorized, "unauthorized")
		return nil
	}
	ctx, cancel = context.WithTimeout(context.Background(), millis(int(h.config.GetAuthTimeoutMs())))
	defer cancel()
	for {
		h.mu.Lock()
		generation := reservation.account.generation
		closing := h.closing
		h.mu.Unlock()
		if closing {
			_ = conn.Close(websocket.StatusGoingAway, "server-shutdown")
			return nil
		}
		identity, err = a.presenceIdentity(ctx, session, true)
		h.mu.Lock()
		if h.closing {
			h.mu.Unlock()
			_ = conn.Close(websocket.StatusGoingAway, "server-shutdown")
			return nil
		}
		if generation != reservation.account.generation {
			h.mu.Unlock()
			if ctx.Err() != nil {
				_ = conn.Close(websocket.StatusInternalError, "auth-unavailable")
				return nil
			}
			continue
		}
		if err != nil || identity.Lease != auth.Lease || identity.ID != reservation.id {
			h.mu.Unlock()
			code := presenceUnauthorized
			reason := "unauthorized"
			var f *failure
			if err != nil && !errors.As(err, &f) {
				code = websocket.StatusInternalError
				reason = "auth-unavailable"
			}
			if err == nil && identity.Lease != auth.Lease {
				code = presenceSuperseded
				reason = "superseded"
			}
			_ = conn.Close(code, reason)
			return nil
		}
		// Successful registration continues with the lock held and a current generation.
		break
	}
	if len(h.peers) >= int(h.config.GetMaxConnections()) && h.peers[identity.ID] == nil {
		h.mu.Unlock()
		_ = conn.Close(websocket.StatusTryAgainLater, "presence-full")
		return nil
	}
	peerCtx, peerCancel := context.WithCancel(context.Background())
	p := &presencePeer{identity: identity, account: reservation.account, conn: conn, ctx: peerCtx, cancel: peerCancel, queue: make(chan []byte, int(h.config.GetQueueMessages())), lastActivity: time.Now()}
	if old := h.peers[identity.ID]; old != nil {
		h.leaveFights(old, false)
		if old.identity.Lease == identity.Lease && old.identity.World == identity.World {
			if old.grace != nil {
				old.grace.Stop()
			}
			p.area = old.area
			p.pos = old.pos
			p.lastPos = old.lastPos
			p.lastJoin = old.lastJoin
			p.lastEmote = old.lastEmote
			old.stop(presenceReplaced, "replaced")
		} else {
			old.stop(presenceSuperseded, "superseded")
			h.remove(old)
		}
	}
	h.admit(p)
	p.pingAt = time.Now()
	h.sweepOnce.Do(func() {
		h.sweepStarted = true
		go func() {
			defer close(h.sweepDone)
			a.presenceSweep()
		}()
	})
	h.send(p, &contract.PresenceReady{AccountId: identity.ID})
	if p.area != "" {
		h.room(p)
		h.broadcast(p, &contract.PresenceJoin{Area: p.area, Player: p.player()})
	}
	h.mu.Unlock()
	a.syncFightPresence(p)
	done := make(chan struct{})
	go func() { defer close(done); a.presenceWriter(p) }()
	authDone := make(chan struct{})
	go func() { defer close(authDone); a.presenceRevalidator(p) }()
	// The writer owns termination deadlines; this read stays alive for ping/pong
	// and close handshakes even after cancellation of application work.
	a.presenceReader(p)
	p.stop(websocket.StatusNormalClosure, "disconnected")
	<-done
	<-authDone
	h.detach(p)
	return nil
}

func (a *Server) presenceReader(p *presencePeer) {
	h := a.presence
	ingress := newPresenceIngress(h.config)
	for {
		typ, b, err := p.conn.Read(context.Background())
		if err != nil {
			return
		}
		if p.ctx.Err() != nil {
			return
		}
		if typ != websocket.MessageBinary {
			p.stop(websocket.StatusUnsupportedData, "binary-required")
			return
		}
		admitted, sustained := ingress.admit(time.Now(), h.config)
		if !admitted {
			if sustained {
				p.stop(websocket.StatusPolicyViolation, "rate-limited")
				return
			}
			continue
		}
		message, err := decodePresence(b)
		if err != nil {
			p.stop(websocket.StatusPolicyViolation, "invalid-message")
			return
		}
		if err := validateFightInput(message); err != nil {
			p.stop(websocket.StatusPolicyViolation, "invalid-fight")
			return
		}
		// Client messages cannot carry server identity or roster fields.
		if join := message.GetJoin(); join != nil && join.Player != nil || message.GetPos() != nil && message.GetPos().AccountId != nil || message.GetEmote() != nil && message.GetEmote().AccountId != nil || message.GetAbility() != nil && message.GetAbility().AccountId != nil {
			p.stop(websocket.StatusPolicyViolation, "invalid-message")
			return
		}
		// Positions and emotes are immutable snapshots. Encode outside h.mu;
		// throttling, room membership, ordering and enqueue stay under the lock.
		var encoded []byte
		var encodeErr error
		if pos := message.GetPos(); pos != nil {
			outbound := proto.Clone(pos).(*contract.PresencePosition)
			outbound.AccountId = proto.String(p.identity.ID)
			// Only the poses this contract names travel on (3.4);
			// anything else reads as on foot.
			if pose := outbound.GetPose(); poseOf(pose) != pose {
				outbound.Pose = nil
			}
			encoded, encodeErr = encodePresence(outbound)
		} else if emote := message.GetEmote(); emote != nil {
			encoded, encodeErr = encodePresence(&contract.PresenceEmote{Id: emote.Id, AccountId: proto.String(p.identity.ID)})
		}
		now := time.Now()
		h.mu.Lock()
		if h.peers[p.identity.ID] != p || p.ctx.Err() != nil {
			h.mu.Unlock()
			return
		}
		p.lastActivity = now
		switch event := message.Event.(type) {
		case *contract.PresenceMessage_Heartbeat:
		case *contract.PresenceMessage_Join:
			if !validPresenceRoom(event.Join.Area) {
				p.stop(websocket.StatusPolicyViolation, "invalid-room")
				h.mu.Unlock()
				return
			}
			if !p.lastJoin.IsZero() && now.Sub(p.lastJoin) < millis(int(h.config.GetJoinCooldownMs())) {
				h.mu.Unlock()
				continue
			}
			p.lastJoin = now
			// The socket's first join: the rooms it covers already (inherited
			// at registration from a socket in its leave grace) were announced
			// before the client named its area, so they are announced again.
			// A later join (a chunk crossing) keeps its rooms as they are.
			first := !p.clientJoined
			p.clientJoined = true
			if p.area == event.Join.Area {
				h.room(p)
				if first {
					h.rejoinFights(p)
				}
				h.mu.Unlock()
				continue
			}
			n := 0
			for _, other := range h.worlds[p.identity.World] {
				if other != p && other.area == event.Join.Area {
					n++
				}
			}
			if n >= int(h.config.GetMaxRoomPlayers()) {
				p.stop(websocket.StatusTryAgainLater, "room-full")
				h.mu.Unlock()
				return
			}
			// Walking from one Wilds chunk into the next, only the peers
			// that drop out of the 3x3 around the player see them leave.
			if old := p.area; old != "" {
				b, err := encodePresence(&contract.PresenceLeave{AccountId: p.identity.ID})
				h.broadcastWhere(p, b, err, func(q *presencePeer) bool { return sharedRoom(q.area, old) && !sharedRoom(q.area, event.Join.Area) })
			}
			_, _, wasWilds := wildsRoomChunk(p.area)
			_, _, isWilds := wildsRoomChunk(event.Join.Area)
			if !wasWilds || !isWilds {
				h.leaveFights(p, true)
				p.pos = nil
			}
			p.area = event.Join.Area
			h.retainFightCoverage(p)
			if first {
				h.rejoinFights(p)
			}
			h.room(p)
			h.broadcast(p, &contract.PresenceJoin{Area: p.area, Player: p.player()})
		case *contract.PresenceMessage_Pos:
			position := event.Pos
			if p.area == "" || position.X == nil || position.Y == nil || position.Facing == nil || position.Facing.X == nil || position.Facing.Y == nil || position.Moving == nil {
				p.stop(websocket.StatusPolicyViolation, "invalid-position")
				h.mu.Unlock()
				return
			}
			x, y, fx, fy := *position.X, *position.Y, *position.Facing.X, *position.Facing.Y
			length := fx*fx + fy*fy
			if !finitePresence(x) || !finitePresence(y) || !finitePresence(fx) || !finitePresence(fy) || math.Abs(x) > 1e6 || math.Abs(y) > 1e6 || math.Abs(length-1) > 0.01 {
				p.stop(websocket.StatusPolicyViolation, "invalid-position")
				h.mu.Unlock()
				return
			}
			// In the Wilds the position must stand inside the frontier, as
			// every `where` must. It needn't be in the room's own chunk:
			// crossing a chunk edge, the join waits out its cooldown. One
			// outside is dropped, neither kept nor relayed.
			if _, _, inWilds := wildsRoomChunk(p.area); inWilds && !positionInsideFrontier(p.identity.World, x, y) {
				h.mu.Unlock()
				continue
			}
			if !p.lastPos.IsZero() && now.Sub(p.lastPos) < time.Second/time.Duration(int(h.config.GetPositionHz())) {
				h.mu.Unlock()
				continue
			}
			p.lastPos = now
			pose := poseOf(position.GetPose())
			p.pos = &presencePosition{x, y, rules.Position{X: fx, Y: fy}, *position.Moving, pose}
			h.broadcastEncoded(p, encoded, encodeErr)
		case *contract.PresenceMessage_Emote:
			if p.area == "" || !slices.Contains(h.config.GetEmotes(), event.Emote.Id) {
				p.stop(websocket.StatusPolicyViolation, "invalid-emote")
				h.mu.Unlock()
				return
			}
			if !p.lastEmote.IsZero() && now.Sub(p.lastEmote) < millis(int(h.config.GetEmoteCooldownMs())) {
				h.mu.Unlock()
				continue
			}
			p.lastEmote = now
			h.broadcastEncoded(p, encoded, encodeErr)
		case *contract.PresenceMessage_FightSwing:
			h.handleFightSwing(p, event.FightSwing)
		case *contract.PresenceMessage_Ability:
			// A cast's fight part takes the counter it shares with swings first.
			cast := event.Ability.Fight
			if cast != nil && !h.takeFightCounter(p, cast.SwingCounter) {
				h.mu.Unlock()
				continue
			}
			// A cast on screen, a signature or a level-20 move (4.5): relayed
			// to the room when the table knows the move, the sender's craft
			// and level mark allow it and its own cooldown has passed.
			// allowAbility is the one owner of those costs; a fight cast it
			// refuses is answered NOT_ALLOWED, anything else is dropped.
			if !h.allowAbility(p, h.now(), event.Ability) {
				if cast != nil {
					h.refuseFight(p, cast.SwingCounter, contract.FightRefusedReason_FIGHT_REFUSED_REASON_NOT_ALLOWED)
				}
				h.mu.Unlock()
				continue
			}
			// Encoded here, not above: the relay carries the caster's ward
			// pulse, read from magic that refreshes under h.mu.
			relayed, relayErr := relayedAbility(p, event.Ability)
			h.broadcastEncoded(p, relayed, relayErr)
			h.scheduleWard(p, event.Ability)
			// The sim applies only the effect on the rooms' enemies.
			if cast != nil {
				h.handleFightCast(p, event.Ability)
			}
		default:
			p.stop(websocket.StatusPolicyViolation, "invalid-message")
			h.mu.Unlock()
			return
		}
		h.mu.Unlock()
		if message.GetPos() != nil || message.GetJoin() != nil {
			a.syncFightPresence(p)
		}
	}
}

func finitePresence(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }

// presenceWriter drains the peer's queue into frames. It has no timer of
// its own: idle checks and pings are the hub sweep's (presenceSweep), so
// nothing but the queue and the peer's end wakes it.
func (a *Server) presenceWriter(p *presencePeer) {
	h := a.presence
	// frame is this writer's one buffer: it grows to the frame cap once.
	frame := make([]byte, 0, 4096)
	for {
		if p.ctx.Err() != nil {
			_ = p.conn.Close(p.closeCode, p.closeReason)
			return
		}
		select {
		case <-p.ctx.Done():
			_ = p.conn.Close(p.closeCode, p.closeReason)
			return
		case b := <-p.queue:
			// One frame carries whatever is queued when the writer wakes
			// (never waiting for more), so a writer that is behind sends
			// batches and one that is not sends each event at once. An
			// event that would not fit starts the next frame.
			for b != nil && p.ctx.Err() == nil {
				var drained int
				frame, b, drained = fillPresenceFrame(frame, b, p.queue)
				p.queuedBytes.Add(-int64(drained))
				// Cancelling coder/websocket Write closes the transport. Let a bounded
				// in-flight write finish so takeover can send its explicit close code.
				ctx, cancel := context.WithTimeout(context.Background(), millis(int(h.config.GetWriteTimeoutMs())))
				err := p.conn.Write(ctx, websocket.MessageBinary, frame)
				cancel()
				if err != nil {
					p.stop(websocket.StatusTryAgainLater, "slow-consumer")
					break
				}
			}
		}
	}
}

// presenceSweep is the hub's one timer for every socket: each pass stops
// the peers idle past the timeout and starts a ping for each whose last
// ping is an interval old. It runs from the first registered peer until
// ClosePresence; its period keeps the configured timeouts' resolution.
func (a *Server) presenceSweep() {
	h := a.presence
	c := h.config
	period := min(time.Second, millis(int(c.GetIdleTimeoutMs()))/4, millis(int(c.GetPingIntervalMs()))/2)
	ticker := time.NewTicker(max(period, time.Millisecond))
	defer ticker.Stop()
	for {
		select {
		case <-h.sweepStop:
			return
		case <-ticker.C:
		}
		now := time.Now()
		h.mu.Lock()
		for _, p := range h.peers {
			if p.detached || p.ctx.Err() != nil {
				continue
			}
			if now.Sub(p.lastActivity) >= millis(int(c.GetIdleTimeoutMs())) {
				p.stop(presenceIdle, "idle-timeout")
				continue
			}
			if !p.pinging && now.Sub(p.pingAt) >= millis(int(c.GetPingIntervalMs())) {
				p.pinging, p.pingAt = true, now
				h.pingWG.Add(1)
				go func() {
					defer h.pingWG.Done()
					a.pingPeer(p)
				}()
			}
		}
		h.mu.Unlock()
	}
}

// pingPeer is one ping's round trip, off the sweep and off the writer
// (coder/websocket allows Ping beside Write). A pong that does not come
// in time ends the peer; in-flight is cleared on every path, and a peer
// that ended meanwhile is never pinged again (the sweep skips it).
func (a *Server) pingPeer(p *presencePeer) {
	h := a.presence
	defer func() {
		h.mu.Lock()
		p.pinging = false
		h.mu.Unlock()
	}()
	if p.ctx.Err() != nil {
		return
	}
	ctx, cancel := context.WithTimeout(p.ctx, millis(int(h.config.GetPongTimeoutMs())))
	defer cancel()
	if err := p.conn.Ping(ctx); err != nil && p.ctx.Err() == nil {
		p.stop(presenceIdle, "pong-timeout")
	}
}

// Reader-owned token bucket: denied messages never parse JSON or take h.mu.
type presenceIngress struct {
	tokens                        float64
	last, excessSince, lastExcess time.Time
}

func newPresenceIngress(c *content.Presence) presenceIngress {
	return presenceIngress{tokens: float64(c.IncomingBurst), last: time.Now()}
}

func (b *presenceIngress) admit(now time.Time, c *content.Presence) (bool, bool) {
	b.tokens = min(float64(c.IncomingBurst), b.tokens+max(0, now.Sub(b.last).Seconds())*float64(c.IncomingMessagesPerSecond))
	b.last = now
	if b.tokens >= float64(c.IncomingBurst) || now.Sub(b.lastExcess) >= time.Second {
		b.excessSince = time.Time{}
	}
	if b.tokens >= 1 {
		b.tokens--
		return true, false
	}
	if b.excessSince.IsZero() {
		b.excessSince = now
	}
	b.lastExcess = now
	return false, now.Sub(b.excessSince) >= millis(int(c.GetIncomingExcessMs()))
}
