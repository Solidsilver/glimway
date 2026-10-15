package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
)

// 037 is a cutover snapshot: no live catalogue, geometry, light or generator
// configuration may change how an old database upgrades.
var footprints037 = map[string][2]int{
	"amber-sconce":     {1, 1},
	"apothecary-shelf": {2, 1},
	"bookshelf":        {2, 1},
	"braided-rug":      {2, 2},
	"candle-hulls":     {1, 1},
	"carting-bunting":  {2, 1},
	"carved-bed":       {2, 2},
	"closure-lamp":     {1, 1},
	"display-stand":    {1, 1},
	"door-fox":         {1, 1},
	"drying-rack":      {1, 1},
	"empty-chair":      {1, 1},
	"gate-shelf":       {1, 1},
	"iron-lantern":     {1, 1},
	"keepsake-cabinet": {1, 1},
	"lantern-post":     {1, 1},
	"naming-frame":     {1, 1},
	"oak-table":        {2, 2},
	"pencil-map":       {2, 1},
	"potted-fern":      {1, 1},
	"pressed-flowers":  {1, 1},
	"raised-bed":       {2, 1},
	"reading-chair":    {1, 2},
	"stable":           {4, 3},
	"stone-hearth":     {2, 1},
	"tool-rack":        {2, 1},
	"wash-basin":       {1, 1},
	"window-lamp":      {1, 1},
	"wooden-stool":     {1, 1},
	"woodpile":         {2, 1},
	"woven-basket":     {1, 1},
	"writing-desk":     {2, 1},
}

// Lot-local Hearthwick 2 reservations: outside the private ground (the fences,
// verges, back lantern line, gate, sign and shelf), the home site, the L-path to
// the front gate (east on even lots, west on odd) and the mailbox.
func reserved037(gate, x, y int) bool {
	pathLo, pathHi, mailbox := 13, 22, 21
	if gate%2 == 1 {
		pathLo, pathHi, mailbox = 1, 10, 2
	}
	return x < 1 || x > 22 || y < 2 || y > 21 || x >= 8 && x <= 15 && y >= 3 && y <= 8 ||
		x >= 11 && x <= 12 && y >= 9 && y <= 12 || x >= pathLo && x <= pathHi && y >= 11 && y <= 12 || x == mailbox && y == 10
}

type piece037 struct {
	id, home, def, world          string
	gate, x, y, rot, stalls, w, h int
	keep                          bool
}
type landRow037 struct {
	home, id, def string
	x, y          int
	at, day       int64
}

func moveHomes037(tx *sql.Tx) error {
	gates := map[string]int{}
	rows, err := tx.Query(`SELECT id,gate FROM homesteads`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id string
		var gate int
		if err = rows.Scan(&id, &gate); err != nil {
			rows.Close()
			return err
		}
		gates[id] = gate
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	// Explicit columns keep archived row shape stable if the live schema grows.
	for _, table := range []string{"homestead_cleared", "homestead_stumps", "homestead_plants"} {
		columns := "homestead_id,x,y"
		if table == "homestead_stumps" {
			columns += ",felled_at"
		}
		if table == "homestead_plants" {
			columns = "id,homestead_id,item_def,x,y,planted_at,planted_day"
		}
		rows, err := tx.Query("SELECT " + columns + " FROM " + table + " ORDER BY homestead_id,x,y")
		if err != nil {
			return err
		}
		var records []landRow037
		for rows.Next() {
			var r landRow037
			if table == "homestead_plants" {
				err = rows.Scan(&r.id, &r.home, &r.def, &r.x, &r.y, &r.at, &r.day)
			} else if table == "homestead_stumps" {
				err = rows.Scan(&r.home, &r.x, &r.y, &r.at)
			} else {
				err = rows.Scan(&r.home, &r.x, &r.y)
			}
			if err != nil {
				rows.Close()
				return err
			}
			records = append(records, r)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if _, err = tx.Exec("DELETE FROM " + table); err != nil {
			return err
		}
		for _, r := range records {
			x, y := r.x-8, r.y-3
			if reserved037(gates[r.home], x, y) {
				identity := fmt.Sprintf("%d,%d", r.x, r.y)
				payload := []any{r.home, r.x, r.y}
				if table == "homestead_stumps" {
					payload = append(payload, r.at)
				}
				if table == "homestead_plants" {
					identity = r.id
					payload = []any{r.id, r.home, r.def, r.x, r.y, r.at, r.day}
				}
				raw, err := json.Marshal(payload)
				if err != nil {
					return err
				}
				if _, err = tx.Exec(`INSERT INTO homestead_land_archive(homestead_id,kind,identity,payload) VALUES(?,?,?,?)`, r.home, table, identity, string(raw)); err != nil {
					return err
				}
				if table == "homestead_plants" {
					if _, err = tx.Exec(`INSERT INTO item_stacks(location,owner,item_def,maker_id,qty) VALUES('storage',?,?,'',1) ON CONFLICT(location,owner,item_def,maker_id) DO UPDATE SET qty=qty+1`, r.home, r.def); err != nil {
						return err
					}
				}
				continue
			}
			if table == "homestead_plants" {
				_, err = tx.Exec("INSERT INTO "+table+"("+columns+") VALUES(?,?,?,?,?,?,?)", r.id, r.home, r.def, x, y, r.at, r.day)
			} else if table == "homestead_stumps" {
				_, err = tx.Exec("INSERT INTO "+table+"("+columns+") VALUES(?,?,?,?)", r.home, x, y, r.at)
			} else {
				_, err = tx.Exec("INSERT INTO "+table+"("+columns+") VALUES(?,?,?)", r.home, x, y)
			}
			if err != nil {
				return err
			}
		}
	}
	rows, err = tx.Query(`SELECT i.id,i.homestead_id,i.item_def,i.x,i.y,i.rotation,COALESCE(i.stalls,1),h.world_id,h.gate FROM homestead_items i JOIN homesteads h ON h.id=i.homestead_id WHERE i.location='placed' AND i.scene='outdoor' ORDER BY i.id`)
	if err != nil {
		return err
	}
	var pieces []piece037
	for rows.Next() {
		var p piece037
		if err = rows.Scan(&p.id, &p.home, &p.def, &p.x, &p.y, &p.rot, &p.stalls, &p.world, &p.gate); err != nil {
			rows.Close()
			return err
		}
		p.x -= 8
		p.y -= 3
		pieces = append(pieces, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	ground := map[string][]byte{}
	for i := range pieces {
		p := &pieces[i]
		if ground[p.home] == nil {
			tiles := generate037(p.world, p.gate)
			rows, err = tx.Query(`SELECT x,y FROM homestead_cleared WHERE homestead_id=?`, p.home)
			if err != nil {
				return err
			}
			for rows.Next() {
				var x, y int
				if err = rows.Scan(&x, &y); err != nil {
					rows.Close()
					return err
				}
				if x >= 0 && x < 24 && y >= 0 && y < 24 {
					k := tiles[y*24+x]
					if k == 1 || k == 2 || k == 3 {
						tiles[y*24+x] = 0
					}
				}
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return err
			}
			ground[p.home] = tiles
		}
		size, known := footprints037[p.def]
		p.w, p.h = size[0], size[1]
		if p.def == "stable" {
			p.w = 2 + 2*p.stalls
		}
		if p.rot == 90 || p.rot == 270 {
			p.w, p.h = p.h, p.w
		}
		p.keep = known
		for y := p.y; y < p.y+p.h; y++ {
			for x := p.x; x < p.x+p.w; x++ {
				if reserved037(p.gate, x, y) {
					p.keep = false
					continue
				}
				k := ground[p.home][y*24+x]
				if k != 0 && k != 8 {
					p.keep = false
				}
			}
		}
	}
	// Remove unsupported posts first, then furniture. Recompute until removing a
	// post no longer disconnects another piece; two isolated posts cannot self-light.
	for changed := true; changed; {
		changed = false
		for i := range pieces {
			p := &pieces[i]
			if !p.keep {
				continue
			}
			lights := lights037(pieces, p.home, p.id)
			for y := p.y; y < p.y+p.h; y++ {
				for x := p.x; x < p.x+p.w; x++ {
					if !lit037(lights, x, y) {
						p.keep = false
						changed = true
					}
				}
			}
		}
	}
	for _, p := range pieces {
		if p.keep {
			_, err = tx.Exec(`UPDATE homestead_items SET x=?,y=? WHERE id=?`, p.x, p.y, p.id)
		} else {
			_, err = tx.Exec(`UPDATE homestead_items SET location='storage',scene=NULL,x=NULL,y=NULL,rotation=NULL WHERE id=?`, p.id)
		}
		if err != nil {
			return err
		}
	}
	return nil
}
func lit037(lights [][3]int, x, y int) bool {
	for _, l := range lights {
		dx, dy := x-l[0], y-l[1]
		if dx*dx+dy*dy <= l[2]*l[2] {
			return true
		}
	}
	return false
}
func lights037(pieces []piece037, home, except string) [][3]int {
	out := [][3]int{{12, 7, 7}}
	seen := map[string]bool{}
	for grew := true; grew; {
		grew = false
		for _, p := range pieces {
			if p.home == home && p.keep && p.def == "lantern-post" && p.id != except && !seen[p.id] && lit037(out, p.x, p.y) {
				seen[p.id] = true
				out = append(out, [3]int{p.x, p.y, 5})
				grew = true
			}
		}
	}
	return out
}

// generate037 freezes land.GenerateLot at generator 2 for Hearthwick 2: the
// path runs from the site to the front gate (x 23 on even lots, x 0 on odd),
// the back column is the open lantern line, and each side has its own scatter.
func generate037(world string, gateIndex int) []byte {
	const (
		Grass byte = iota
		Tree
		Stump
		Boulder
		Water
		Ford
		Slope
		Edge
		Path
	)
	const W, H = 24, 24
	tiles := make([]byte, W*H)
	at := func(x, y int) byte { return tiles[y*W+x] }
	put := func(x, y int, k byte) { tiles[y*W+x] = k }
	siteX, siteY, siteW, siteH := 8, 3, 8, 6
	siteBottom := siteY + siteH
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			if x == 0 || y == 0 || x == W-1 || y == H-1 {
				put(x, y, Edge)
			} else {
				put(x, y, Grass)
			}
		}
	}
	for y := siteBottom; y <= 12; y++ {
		for x := 11; x <= 12; x++ {
			put(x, y, Path)
		}
	}
	front, back, mailbox := 23, 0, 21
	trees, stumps, boulders := 44, 6, 4
	if gateIndex%2 == 1 {
		front, back, mailbox = 0, 23, 2
		trees, stumps, boulders = 14, 3, 3
	}
	for y := 11; y <= 12; y++ {
		for x := min(front, 11); x <= max(front, 12); x++ {
			put(x, y, Path)
		}
	}
	for y := 2; y <= 21; y++ {
		put(back, y, Grass)
	}
	protected := func(x, y int) bool {
		return x < 1 || x > 22 || y < 2 || y > 21 || at(x, y) == Path || x == mailbox && y == 10 ||
			(x >= siteX-1 && x <= siteX+siteW && y >= siteY-1 && y <= siteBottom)
	}
	seed := seed037(world, gateIndex)
	nextInt := func(n int) int {
		seed += 0x6d2b79f5
		t := seed
		t = (t ^ (t >> 15)) * (t | 1)
		t = (t + ((t ^ (t >> 7)) * (t | 61))) ^ t
		return int((t ^ (t >> 14)) % uint32(n))
	}
	if nextInt(1000) < 350 {
		lo, hi := 3, 6
		if nextInt(2) != 0 {
			lo, hi = 17, 20
		}
		x := lo + nextInt(hi-lo+1)
		ford := 3 + nextInt(H-6)
		for y := 1; y < H-1; y++ {
			if at(x, y) == Grass && !protected(x, y) {
				if y == ford {
					put(x, y, Ford)
				} else {
					put(x, y, Water)
				}
			}
			r := nextInt(4)
			if r == 0 && x > lo {
				x--
			} else if r == 1 && x < hi {
				x++
			}
		}
	}
	if nextInt(1000) < 350 {
		y0 := 2 + nextInt(3)
		x0 := 2 + nextInt(W/3)
		n := 8 + nextInt(10)
		x1 := min(x0+n, W-2)
		for y := y0; y <= y0+1; y++ {
			for x := x0; x < x1; x++ {
				if at(x, y) == Grass && !protected(x, y) {
					put(x, y, Slope)
				}
			}
		}
	}
	scatter := func(n int, kind byte) {
		for i := 0; i < n; i++ {
			x := 1 + nextInt(W-2)
			y := 1 + nextInt(H-2)
			if at(x, y) == Grass && !protected(x, y) {
				put(x, y, kind)
			}
		}
	}
	scatter(trees, Tree)
	scatter(stumps, Stump)
	scatter(boulders, Boulder)
	return tiles
}

func seed037(world string, gate int) uint32 {
	fnv := func(s string) uint32 {
		h := uint32(0x811c9dc5)
		for i := 0; i < len(s); i++ {
			h = (h ^ uint32(s[i])) * 0x01000193
		}
		return h
	}
	mix := func(h, v uint32) uint32 {
		x := (h ^ v) * 0x01000193
		x ^= x >> 15
		x *= 0x85ebca6b
		x ^= x >> 13
		return x
	}
	return mix(mix(mix(mix(0x811c9dc5, fnv(world)), fnv("homestead-land")), 2), uint32(gate))
}
