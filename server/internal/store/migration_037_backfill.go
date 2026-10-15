package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"glimway/content"
)

// Frozen cutover geometry: shift the old 40x30 local frame once. Goods that
// cannot stand on the smaller lot remain owned by that home's storage chest.
func moveHomes037(tx *sql.Tx) error {
	reserved := func(x, y int) bool {
		return x < 3 || x > 20 || y < 2 || y > 18 || x >= 8 && x <= 15 && y >= 3 && y <= 8 || x >= 11 && x <= 12 && y >= 9 || x == 13 && y == 18
	}
	type piece struct {
		id, home, def          string
		x, y, rotation, stalls int
	}
	rows, err := tx.Query(`SELECT id,homestead_id,item_def,x,y,rotation,COALESCE(stalls,1) FROM homestead_items WHERE location='placed' AND scene='outdoor' ORDER BY id`)
	if err != nil {
		return err
	}
	var pieces []piece
	for rows.Next() {
		var p piece
		if err = rows.Scan(&p.id, &p.home, &p.def, &p.x, &p.y, &p.rotation, &p.stalls); err != nil {
			rows.Close()
			return err
		}
		pieces = append(pieces, p)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, p := range pieces {
		x, y := p.x-8, p.y-3
		def, known := content.HomeItemFor(p.def)
		valid := known
		w, h := 1, 1
		if known {
			fp := def.GetFootprint()
			w, h = int(fp[0]), int(fp[1])
			if p.def == content.HomeRules.GetStable().GetItem() {
				w = 2 + 2*p.stalls
			}
			if p.rotation == 90 || p.rotation == 270 {
				w, h = h, w
			}
		}
		for dy := 0; dy < h; dy++ {
			for dx := 0; dx < w; dx++ {
				if reserved(x+dx, y+dy) {
					valid = false
				}
			}
		}
		if valid {
			_, err = tx.Exec(`UPDATE homestead_items SET x=?,y=? WHERE id=?`, x, y, p.id)
		} else {
			_, err = tx.Exec(`UPDATE homestead_items SET location='storage',scene=NULL,x=NULL,y=NULL,rotation=NULL WHERE id=?`, p.id)
		}
		if err != nil {
			return err
		}
	}
	// Delete and reinsert coordinates to avoid negative CHECKs and key collisions.
	for _, table := range []string{"homestead_cleared", "homestead_stumps", "homestead_plants"} {
		rows, err = tx.Query("SELECT * FROM " + table)
		if err != nil {
			return err
		}
		cols, err := rows.Columns()
		if err != nil {
			rows.Close()
			return err
		}
		var records [][]any
		for rows.Next() {
			v := make([]any, len(cols))
			dest := make([]any, len(cols))
			for i := range v {
				dest[i] = &v[i]
			}
			if err = rows.Scan(dest...); err != nil {
				rows.Close()
				return err
			}
			records = append(records, v)
		}
		if err = rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		if _, err = tx.Exec("DELETE FROM " + table); err != nil {
			return err
		}
		for _, v := range records {
			xi, yi, hi := 1, 2, 0
			if table == "homestead_plants" {
				xi, yi, hi = 3, 4, 1
			}
			x, y := int(v[xi].(int64))-8, int(v[yi].(int64))-3
			if reserved(x, y) {
				raw, e := json.Marshal(v)
				if e != nil {
					return e
				}
				identity := fmt.Sprintf("%v,%v", v[xi], v[yi])
				if table == "homestead_plants" {
					identity = fmt.Sprint(v[0])
				}
				if _, err = tx.Exec(`INSERT INTO homestead_land_archive VALUES(?,?,?,?)`, v[hi], table, identity, string(raw)); err != nil {
					return err
				}
				if table == "homestead_plants" {
					if _, err = tx.Exec(`INSERT INTO item_stacks(location,owner,item_def,maker_id,qty) VALUES('storage',?,?,'',1) ON CONFLICT(location,owner,item_def,maker_id) DO UPDATE SET qty=qty+1`, v[hi], v[2]); err != nil {
						return err
					}
				}
				continue
			}
			v[xi], v[yi] = x, y
			marks := "?"
			for range v[1:] {
				marks += ",?"
			}
			if _, err = tx.Exec("INSERT INTO "+table+" VALUES("+marks+")", v...); err != nil {
				return err
			}
		}
	}
	return nil
}
