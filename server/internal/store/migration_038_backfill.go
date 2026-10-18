package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
)

// lay038 is what each laid ground kind cost in 0.11.2 (content/wilds.json
// paths.lay at v0.11.2): a frozen snapshot, so a later catalogue change
// can't alter how an old database is refunded.
var lay038 = map[string]struct {
	material string
	cost     int
}{
	"stone": {"stone", 1},
	"plank": {"timber", 1},
}

// refundPaths038 crates the paths 038 set aside (lasting_geography_paths):
// each laid tile's material goes to whoever laid it, in one crate a chunk at
// Pell's, each entry's reason "land-changed" so Pell can say why. Free
// clearing gave nothing, and an account that has gone gets no entry. Then
// the staged rows go.
func refundPaths038(tx *sql.Tx) error {
	rows, err := tx.Query("SELECT world_id,chunk,state FROM lasting_geography_paths ORDER BY world_id,chunk,epoch")
	if err != nil {
		return err
	}
	type place struct{ world, chunk string }
	owed := map[place]map[[2]string]int{}
	var order []place
	for rows.Next() {
		var p place
		var state string
		if err = rows.Scan(&p.world, &p.chunk, &state); err != nil {
			rows.Close()
			return err
		}
		var g struct {
			Changes []struct {
				Change string `json:"change"`
				By     string `json:"by"`
			} `json:"changes"`
		}
		if json.Unmarshal([]byte(state), &g) != nil {
			continue
		}
		for _, c := range g.Changes {
			lay, ok := lay038[c.Change]
			if !ok || c.By == "" {
				continue
			}
			if owed[p] == nil {
				owed[p] = map[[2]string]int{}
				order = append(order, p)
			}
			owed[p][[2]string{c.By, lay.material}] += lay.cost
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	now := time.Now().Unix()
	for _, p := range order {
		var cx, cy int
		if _, err = fmt.Sscanf(p.chunk, "%d:%d", &cx, &cy); err != nil {
			return fmt.Errorf("staged path chunk %q: %w", p.chunk, err)
		}
		keys := make([][2]string, 0, len(owed[p]))
		for k := range owed[p] {
			var known bool
			if err = tx.QueryRow("SELECT EXISTS(SELECT 1 FROM players WHERE account_id=?)", k[0]).Scan(&known); err != nil {
				return err
			}
			if known {
				keys = append(keys, k)
			}
		}
		if len(keys) == 0 {
			continue
		}
		slices.SortFunc(keys, func(a, b [2]string) int { return strings.Compare(a[0]+"\x00"+a[1], b[0]+"\x00"+b[1]) })
		crate, err := Random()
		if err != nil {
			return err
		}
		if _, err = tx.Exec("INSERT INTO recovery_crates(id,world_id,source,cx,cy,lapsed_at) VALUES(?,?,?,?,?,?)", crate, p.world, "land-changed:"+p.chunk, cx, cy, now); err != nil {
			return err
		}
		for _, k := range keys {
			if _, err = tx.Exec(`INSERT INTO recovery_entries(crate_id,account_id,kind,item_def,qty,reason) VALUES(?,?,'stack',?,?,'land-changed')`, crate, k[0], k[1], owed[p][k]); err != nil {
				return err
			}
		}
	}
	_, err = tx.Exec("DROP TABLE lasting_geography_paths")
	return err
}
