//go:build dev

package api

import (
	"context"
	"encoding/json"
	"slices"
	"testing"

	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
)

// The dev fall is the sim's fall, durably written before the route answers,
// and nothing more: the camp is claimed only through the production claim
// route, by its witnesses, once.
func TestDevFightFallIsWrittenAndClaimedOnlyThroughTheClaimRoute(t *testing.T) {
	x, p, cookie, state := adapterFightFixture(t)
	x.api.syncFightPresence(p)
	join := queuedFightFrame(t, p).GetFightJoin()
	if join == nil {
		t.Fatal("no join")
	}
	camp := x.chunk(cookie, join.RoomKey.Epoch, 0, 0, 0, 200).GetEntities()
	idx := slices.IndexFunc(camp, func(e *contract.WildsEntity) bool { return e.Id == "camp:0:0:0" })
	if idx < 0 {
		t.Fatal("no camp:0:0:0")
	}
	entity := camp[idx]
	if _, code := x.claim(cookie, state, "retry-after-fall", join.RoomKey.Epoch, entity, 0, at(entity, 0), 409); code != "not-defeated" {
		t.Fatal("claim before the fall", code)
	}
	w := x.devFightFall(cookie, `{"entity":"camp:0:0:0"}`)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var out devFightFall
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	// Drained before the answer: the store holds it, exactly keyed.
	k := store.FallKey{World: p.identity.World, Realm: join.RoomKey.Realm, Layer: join.RoomKey.Layer, CX: 0, CY: 0, Epoch: out.Epoch, Entity: out.Entity, Cycle: out.Cycle}
	rec, ok, err := store.ReadFall(context.Background(), x.db.DB, k)
	if err != nil || !ok || rec.FellAt != out.FellAt || !slices.Equal(rec.Witnesses, []string{p.identity.ID}) {
		t.Fatal("fall not durable", rec, ok, err)
	}
	near := x.near(cookie, 0, 0, 200).Entities
	if i := slices.IndexFunc(near, func(e *contract.WildsEntityState) bool { return e.Id == "camp:0:0:0" }); i < 0 || !near[i].CampClaimable {
		t.Fatal("witness cannot see the claim")
	}
	oc, ostate := x.member("outsider", state.WorldID)
	if _, code := x.claim(oc, ostate, "outsider", out.Epoch, entity, int(out.Cycle), at(entity, 0), 409); code != "condition-unmet" {
		t.Fatal("a non-witness claimed", code)
	}
	// The bounded-wait refusal is transient: the exact key can be retried
	// after the fall is durable and complete the claim.
	if _, code := x.claim(cookie, state, "retry-after-fall", out.Epoch, entity, int(out.Cycle), at(entity, 0), 200); code != "" {
		t.Fatal("witness claim", code)
	}
	if _, code := x.claim(cookie, state, "again", out.Epoch, entity, int(out.Cycle), at(entity, 0), 409); code != "already-claimed" {
		t.Fatal("claimed twice", code)
	}
}
