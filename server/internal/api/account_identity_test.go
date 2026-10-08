package api

import (
	"context"
	"glimway/server/internal/store"
	"testing"
)

func TestNewRandomIdentityMailAndRemoval(t *testing.T) {
	x := newRig(t)
	for _, subject := range []string{"sender-subject", "recipient-subject"} {
		if err := x.db.Allow(context.Background(), subject, true); err != nil {
			t.Fatal(err)
		}
	}
	status, first, code, sender := x.request("POST", "/api/session", map[string]any{"userId": "sender-subject", "token": secret}, nil)
	if status != 200 {
		t.Fatal(status, code)
	}
	if first.AccountID == "sender-subject" || len(first.AccountID) != 64 {
		t.Fatal("new account id is not random", first.AccountID)
	}
	invite, err := x.db.Invite(context.Background(), first.WorldID)
	if err != nil {
		t.Fatal(err)
	}
	status, second, code, recipient := x.request("POST", "/api/session", map[string]any{"userId": "recipient-subject", "token": secret, "invite": invite}, nil)
	if status != 200 {
		t.Fatal(status, code)
	}
	if second.AccountID == "recipient-subject" || second.WorldID != first.WorldID {
		t.Fatal("new recipient identity", second)
	}
	play := x.expect("POST", "/api/play", map[string]any{"clientId": "device"}, sender, 200)
	if _, err = x.db.DB.Exec("INSERT INTO item_stacks(location,owner,item_def,qty,maker_id) VALUES('pack',?,'timber',2,'')", first.AccountID); err != nil {
		t.Fatal(err)
	}
	send := x.rawHTTP("POST", "/api/mail", map[string]any{"lease": play.Lease, "baseRev": play.Version, "key": "mail", "toId": second.AccountID, "asset": map[string]any{"kind": "material", "id": "timber", "qty": 1}}, sender)
	if send.Code != 200 {
		t.Fatal(send.Code, send.Body.String())
	}
	x.expect("GET", "/api/state", nil, recipient, 200)
	var returned int
	if err = x.db.DB.QueryRow("SELECT count(*) FROM mail WHERE returned_at IS NOT NULL").Scan(&returned); err != nil || returned != 0 {
		t.Fatal("random-id recipient was treated as removed")
	}
	if err = x.db.Allow(context.Background(), "recipient-subject", false); err != nil {
		t.Fatal(err)
	}
	x.expect("GET", "/api/state", nil, recipient, 401)
	if err = x.db.DB.QueryRow("SELECT count(*) FROM mail WHERE returned_at IS NOT NULL AND return_reason='recipient-removed'").Scan(&returned); err != nil || returned != 1 {
		t.Fatal("subject removal did not return account mail", returned, err)
	}
	id, err := store.AccountForSubject(context.Background(), x.db.DB, "habitica", "recipient-subject")
	if err != nil || id != second.AccountID {
		t.Fatal("removal deleted stable identity")
	}
}

func TestRandomIdentityGivingMakerRevocationAndSyncSubject(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("player-subject")
	makerCookie, maker := x.member("maker-subject", s.WorldID)
	if s.AccountID == "player-subject" || maker.AccountID == "maker-subject" {
		t.Fatal("fixture conflated accounts and subjects")
	}
	invite := inviteReq(t, x, "POST", "/api/invites", makerCookie, 200).Code
	if err := x.db.Allow(context.Background(), "maker-subject", false); err != nil {
		t.Fatal(err)
	}
	if count(t, x.db, "SELECT count(*) FROM invites WHERE created_by=? AND code_hash=? AND revoked_at IS NOT NULL", maker.AccountID, store.Hash(invite)) != 1 {
		t.Fatal("subject removal missed random-id creator")
	}
	x.stack(s.AccountID, "keepers-twists", maker.AccountID, 1)
	x.refresh(c, &s)
	response := x.opRefreshing(c, &s, "give", map[string]any{"toId": maker.AccountID, "asset": map[string]any{"kind": "item", "id": "keepers-twists", "qty": 1, "maker": maker.AccountID}}, 403)
	if response.Error.Code != "recipient-unavailable" {
		t.Fatal("removed random-id recipient admitted")
	}
	x.opRefreshing(c, &s, "use", map[string]any{"itemDef": "keepers-twists", "maker": maker.AccountID}, 200)
	if count(t, x.db, "SELECT count(*) FROM mail WHERE kind='thanks' AND to_id=?", maker.AccountID) != 0 {
		t.Fatal("removed random-id maker thanked")
	}
	x.refresh(c, &s)
	p := profile("player-subject", 1, 0, 20)
	x.expect("POST", "/api/sync", syncBody(s, p, s.State), c, 200)
	x.refresh(c, &s)
	p.ID = s.AccountID
	status, _, code, _ := x.request("POST", "/api/sync", syncBody(s, p, s.State), c)
	if status != 409 || code != "account-switch" {
		t.Fatal("sync compared account with Habitica subject", status, code)
	}
}
