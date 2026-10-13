package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"glimway/content"
	"glimway/server/internal/fights"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/proto"
)

// The next chunk blocks after (0,0)'s ground has been read. Holding h.mu
// while releasing it lets a clear commit after the wake commits but before
// the wake can publish, without relying on mutex waiter scheduling.
type reviewGroundChunks struct {
	entered, release chan struct{}
	once             sync.Once
	loads            atomic.Int32
}

func (s *reviewGroundChunks) Chunk(ctx context.Context, _ *sql.Tx, _, epoch string, layer, cx, cy int32) (*contract.WildsChunk, error) {
	if cx == 0 && cy == 0 {
		s.loads.Add(1)
	}
	if cx == 1 && cy == 0 {
		s.once.Do(func() {
			close(s.entered)
			select {
			case <-s.release:
			case <-ctx.Done():
			}
		})
	}
	c := &contract.WildsChunk{EpochId: epoch, Realm: content.WildsRules.GetRealm(), Layer: layer, Cx: cx, Cy: cy, Size: 24, Solid: make([]byte, 72)}
	c.Solid[26/8] |= 1 << (26 % 8) // wall at local tile (2,1)
	return c, ctx.Err()
}

func TestFightWakeCannotPublishGroundInvalidatedAfterItsCommit(t *testing.T) {
	for _, cached := range []bool{false, true} {
		name := "uncached"
		if cached {
			name = "cached"
		}
		t.Run(name, func(t *testing.T) {
			x, p, cookie, state := adapterFightFixture(t)
			ep := x.wilds(cookie, "tangle").Epoch
			source := &reviewGroundChunks{entered: make(chan struct{}), release: make(chan struct{})}
			x.api.Config.Chunks = source
			var release sync.Once
			unblock := func() { release.Do(func() { close(source.release) }) }
			t.Cleanup(unblock)
			h := x.api.presence
			location := fightLocation{world: state.WorldID, realm: content.WildsRules.GetRealm()}
			key := fights.Key{World: location.world, Realm: location.realm, Epoch: ep.Id}
			if cached {
				h.mu.Lock()
				h.setFightLocationLocked(location, fightLocationEpoch{key: key})
				h.mu.Unlock()
			}
			done := make(chan struct{})
			go func() { defer close(done); x.api.syncFightPresence(p) }()
			select {
			case <-source.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("wake did not reach the publication barrier")
			}
			func() {
				h.mu.Lock()
				defer h.mu.Unlock()
				unblock()
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				// The single connection cannot be acquired until the wake has
				// committed. Its geometry is now stale, still awaiting h.mu.
				tx, err := x.api.beginTx(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback()
				changes := &contract.GroundChanges{Changes: []*contract.GroundChange{{Tx: 2, Ty: 1, Change: "cleared"}}}
				if err := putGround(ctx, tx, state.WorldID, ep, 0, 0, changes, p.identity.ID, x.now.Load()); err != nil {
					t.Fatal(err)
				}
				if err := tx.Commit(); err != nil {
					t.Fatal(err)
				}
				h.invalidateFightGroundLocked(state.WorldID, ep.Id, 0, 0)
			}()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("wake did not finish after invalidation")
			}
			h.mu.Lock()
			resolved, ok := h.fightLocations[location]
			negative := h.fightFailedWakes[key]
			pending := len(h.fightGroundLoads)
			ground := h.fightGround(p, 24, 24)
			h.mu.Unlock()
			if !ok || !resolved.geometry.Open[26] || !negative {
				t.Fatal("wake restored pre-clear ground or failed to refresh the campless location", ok, negative)
			}
			if end, _ := ground.Dash(24, 24, 1, 0); end <= 27 {
				t.Fatal("cleared tile still blocked the dash", end)
			}
			if source.loads.Load() != 2 {
				t.Fatal("invalidated wake was not reloaded exactly once", source.loads.Load())
			}
			if pending != 0 {
				t.Fatal("wake retained pending load bookkeeping", pending)
			}
		})
	}
}

func TestFightRoomCloseCancelsPendingGroundLoad(t *testing.T) {
	for _, sameEpoch := range []bool{true, false} {
		name := "same-epoch"
		if !sameEpoch {
			name = "older-epoch"
		}
		t.Run(name, func(t *testing.T) {
			x, p, cookie, state := adapterFightFixture(t)
			ep := x.wilds(cookie, "tangle").Epoch
			source := &reviewGroundChunks{entered: make(chan struct{}), release: make(chan struct{})}
			x.api.Config.Chunks = source
			var release sync.Once
			unblock := func() { release.Do(func() { close(source.release) }) }
			t.Cleanup(unblock)
			h := x.api.presence
			key := fights.Key{World: state.WorldID, Realm: content.WildsRules.GetRealm(), Epoch: ep.Id}
			if !sameEpoch {
				key.Epoch += "-older"
			}
			room := &presenceFightRoom{key: key, handle: 1}
			h.mu.Lock()
			h.fightRooms[key] = room
			h.mu.Unlock()
			done := make(chan struct{})
			go func() { defer close(done); x.api.syncFightPresence(p) }()
			select {
			case <-source.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("wake did not read the closing room's ground")
			}
			x.api.fightClosed(room)
			unblock()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("wake did not finish after close")
			}
			wantLoads := int32(1)
			if sameEpoch {
				wantLoads = 2
			}
			if source.loads.Load() != wantLoads {
				t.Fatal("close did not cancel only its own epoch load", source.loads.Load(), wantLoads)
			}
			h.mu.Lock()
			defer h.mu.Unlock()
			if len(h.fightGroundLoads) != 0 || h.fightRooms[key] != nil {
				t.Fatal("closed room or pending load bookkeeping survived")
			}
		})
	}
}

// Seed an actual pre-policy refusal, including its canonical request hash
// and payload, rather than issuing a refusal under the current save policy.
func TestLegacyNotDefeatedClaimRetriesWithSameKey(t *testing.T) {
	for _, pendingFall := range []bool{false, true} {
		name := "durable-fall"
		if pendingFall {
			name = "pending-fall"
		}
		t.Run(name, func(t *testing.T) {
			x := newRig(t)
			cookie, state := x.ready("alice")
			v := x.wilds(cookie, "tangle")
			camp := v.kind(t, "camp")
			account := x.account("alice")
			request := &contract.WildsClaimRequest{Op: op(state.Lease, "legacy-not-defeated"), Epoch: v.Epoch.Id, EntityId: camp.Id, Where: at(camp, 0)}
			const route = "/api/wilds/claim"
			ctx := context.Background()
			tx, err := x.api.beginTx(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			prepared, prior, err := opIdem(ctx, tx, account, route, request.Op.Key, request, x.now.Load())
			if err != nil || prior != nil {
				t.Fatal(prepared, prior, err)
			}
			if err := saveRefusedOp(ctx, tx, account, route, request.Op.Key, prepared.Hash, &failure{status: 409, code: "not-defeated"}, state.Version, x.now.Load()); err != nil {
				t.Fatal(err)
			}
			if err := savePayload(tx, account, route, request.Op.Key, prepared.Payload); err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			if !pendingFall {
				x.campFell(state.WorldID, v.Epoch.Id, camp, 0, account)
			}
			mismatch := proto.Clone(request).(*contract.WildsClaimRequest)
			mismatch.Where.X++
			if _, code := x.call(route, mismatch, cookie, 409); code != "idempotency-mismatch" {
				t.Fatal("legacy hash check", code)
			}
			if n := count(t, x.db, "SELECT count(*) FROM idempotency WHERE account_id=? AND op=? AND key=?", account, route, request.Op.Key); n != 1 {
				t.Fatal("mismatch deleted the legacy refusal", n)
			}
			if pendingFall {
				if _, code := x.call(route, request, cookie, 409); code != "not-defeated" {
					t.Fatal("standing camp claim after legacy lookup", code)
				}
				if n := count(t, x.db, "SELECT count(*) FROM idempotency WHERE account_id=? AND op=? AND key=?", account, route, request.Op.Key); n != 0 {
					t.Fatal("another transient refusal retained the legacy row", n)
				}
				x.campFell(state.WorldID, v.Epoch.Id, camp, 0, account)
			}
			first, code := x.call(route, request, cookie, 200)
			if code != "" || first.GetWildsClaim() == nil {
				t.Fatal("legacy claim did not recover", code)
			}
			replay, _ := x.call(route, request, cookie, 200)
			if !proto.Equal(first.GetWildsClaim(), replay.GetWildsClaim()) {
				t.Fatal("successful claim result did not replay")
			}
			if _, code := x.claim(cookie, state, "fresh-after-legacy", v.Epoch.Id, camp, 0, at(camp, 0), 409); code != "already-claimed" {
				t.Fatal("legacy recovery granted twice", code)
			}
			if n := count(t, x.db, "SELECT count(*) FROM camp_claims WHERE account_id=? AND epoch=? AND entity_id=? AND cycle=0", account, v.Epoch.Id, camp.Id); n != 1 {
				t.Fatal("duplicate cycle claim", n)
			}
			if n := count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND currency='glims' AND reason='wilds-claim'", account); n != 1 {
				t.Fatal("duplicate reward", n)
			}
			var body string
			if err := x.db.DB.QueryRow("SELECT result_json FROM idempotency WHERE account_id=? AND op=? AND key=?", account, route, request.Op.Key).Scan(&body); err != nil {
				t.Fatal(err)
			}
			var result storedResult
			if err := json.Unmarshal([]byte(body), &result); err != nil {
				t.Fatal(err)
			}
			if result.Refused != "" {
				t.Fatal("success did not replace legacy refusal", result.Refused)
			}
		})
	}
}
