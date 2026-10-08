package store

import (
	"path/filepath"
	"testing"
)

func TestRound3UpgradeCursorIdleSessionAndReplayDisplayName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "phase34.sqlite")
	old := newUpgradeFixture(t, path, "004_homestead_wilds.sql", nil)
	var err error
	if _, err = old.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','s',0);
 INSERT INTO players(habitica_id,display_name,world_id,created_at,last_seen_at) VALUES('alice','Keeper','w',1,100);
 INSERT INTO sync_baselines(habitica_id,verified_xp,checkpoint_json,checkpoint_at,updated_at) VALUES('alice',0,'{}',100,100);
 INSERT INTO sessions VALUES('current','alice',1,9999999,'{}',0),('expired','alice',1,2,'{}',0),('later-login','alice',200,9999999,'{}',0);
 INSERT INTO ledger(habitica_id,currency,delta,earned_delta,reason,ref,reported_xp,created_at) VALUES
 ('alice','embers',1,1,'sync','xp',10,99),('alice','embers',1,1,'sync','xp',20,100);
 INSERT INTO idempotency VALUES('alice','spend','legacy','request-hash','{"state":{},"rev":1}',100),('alice','spend','named','other-request-hash','{"state":{},"displayName":"Historical","rev":0}',99);
 `); err != nil {
		t.Fatal(err)
	}
	old.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var cursor int
	if err = s.DB.QueryRow("SELECT checkpoint_ledger_id FROM sync_baselines").Scan(&cursor); err != nil || cursor != 1 {
		t.Fatal("legacy same-second report excluded", cursor, err)
	}
	for id, want := range map[string]int{"current": 100 + 7*86400, "expired": 2, "later-login": 200 + 7*86400} {
		var got int
		if err = s.DB.QueryRow("SELECT expires_at FROM sessions WHERE id_hash=?", id).Scan(&got); err != nil || got != want {
			t.Fatal("legacy idle clamp", id, got, err)
		}
	}
	for key, want := range map[string]string{"legacy": "Keeper", "named": "Historical"} {
		var got string
		if err = s.DB.QueryRow("SELECT json_extract(response_json,'$.displayName') FROM idempotency WHERE key=?", key).Scan(&got); err != nil || got != want {
			t.Fatal("snapshot replay migration", key, got, err)
		}
	}
	var raw string
	if err = s.DB.QueryRow("SELECT request_hash FROM idempotency WHERE key='legacy'").Scan(&raw); err != nil || raw != "request-hash" {
		t.Fatal("canonical request hash changed")
	}
}
