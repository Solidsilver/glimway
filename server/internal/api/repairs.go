package api

import (
	"context"
	"database/sql"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/content"
	"glimway/server/internal/store"
	"net/http"
	"slices"
)

type choreView struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Part        string            `json:"part"`
	Area        string            `json:"area"`
	Target      string            `json:"target"`
	Pos         content.RepairPos `json:"pos"`
	Resident    string            `json:"resident"`
	Hint        string            `json:"hint"`
	Description string            `json:"description"`
}

type mendedView struct {
	RepairID    string `json:"repairId"`
	MendedBy    string `json:"mendedBy"`
	DisplayName string `json:"displayName"`
	MendedAt    int64  `json:"mendedAt"`
}

type choreHistoryView struct {
	ID          string `json:"id"`
	RepairID    string `json:"repairId"`
	RepairName  string `json:"repairName"`
	MendedBy    string `json:"mendedBy"`
	DisplayName string `json:"displayName"`
	MendedAt    int64  `json:"mendedAt"`
}

type repairsView struct {
	Open       []choreView        `json:"open"`
	Mended     []mendedView       `json:"mended"`
	WorldFlags []string           `json:"worldFlags"`
	History    []choreHistoryView `json:"history"`
}

func readRepairs(ctx context.Context, tx *sql.Tx, s store.Snapshot, now int64) (repairsView, error) {
	out := repairsView{
		Open:       []choreView{},
		Mended:     []mendedView{},
		WorldFlags: []string{},
		History:    []choreHistoryView{},
	}

	// 1. Ensure scripted progression:
	// If well-rope not yet recorded in world, add it as open.
	var wellRecorded int
	err := tx.QueryRowContext(ctx, "SELECT count(*) FROM village_repairs WHERE world_id=? AND repair_id='well-rope'", s.WorldID).Scan(&wellRecorded)
	if err != nil {
		return out, err
	}
	if wellRecorded == 0 {
		if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO village_repairs(world_id, repair_id, created_at) VALUES(?, 'well-rope', ?)", s.WorldID, now); err != nil {
			return out, err
		}
	}

	// Check if well-rope is mended
	var wellMended sql.NullInt64
	err = tx.QueryRowContext(ctx, "SELECT mended_at FROM village_repairs WHERE world_id=? AND repair_id='well-rope'", s.WorldID).Scan(&wellMended)
	if err != nil && err != sql.ErrNoRows {
		return out, err
	}
	if wellMended.Valid {
		// Check fence-rail
		var fenceRecorded int
		err = tx.QueryRowContext(ctx, "SELECT count(*) FROM village_repairs WHERE world_id=? AND repair_id='fence-rail'", s.WorldID).Scan(&fenceRecorded)
		if err != nil {
			return out, err
		}
		if fenceRecorded == 0 {
			if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO village_repairs(world_id, repair_id, created_at) VALUES(?, 'fence-rail', ?)", s.WorldID, now); err != nil {
				return out, err
			}
		}
	}

	// Check if fence-rail is mended
	var fenceMended sql.NullInt64
	err = tx.QueryRowContext(ctx, "SELECT mended_at FROM village_repairs WHERE world_id=? AND repair_id='fence-rail'", s.WorldID).Scan(&fenceMended)
	if err != nil && err != sql.ErrNoRows {
		return out, err
	}

	maxOpen := content.RepairRules.Rules.MaxOpen
	if maxOpen <= 0 {
		maxOpen = 3
	}
	perWick := content.RepairRules.Rules.PerWick
	if perWick <= 0 {
		perWick = 1
	}

	if fenceMended.Valid {
		// Break weather (docs/items/crafting-and-repair.md, "The chores
		// list"): roughly one new breakage per wick, never the same thing
		// twice in a row, up to maxOpen open at a time. The world's last
		// break wick is stored, so reads never re-roll the weather.
		var currentOpen int
		err = tx.QueryRowContext(ctx, "SELECT count(*) FROM village_repairs WHERE world_id=? AND mended_at IS NULL", s.WorldID).Scan(&currentOpen)
		if err != nil {
			return out, err
		}
		wick := content.CalendarAt(content.CalendarRules, now).WickNumber

		var lastBreakWick int64
		err = tx.QueryRowContext(ctx, "SELECT last_break_wick FROM village_repair_clock WHERE world_id=?", s.WorldID).Scan(&lastBreakWick)
		if err == sql.ErrNoRows {
			lastBreakWick = 0
			_, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO village_repair_clock(world_id, last_break_wick) VALUES(?, 0)", s.WorldID)
		}
		if err != nil {
			return out, err
		}

		if currentOpen < maxOpen {
			// Never the same thing twice in a row: skip the log's newest mend
			// (rowid breaks ties: two mends in the same second keep their order).
			var lastMended string
			_ = tx.QueryRowContext(ctx, "SELECT repair_id FROM village_repair_log WHERE world_id=? ORDER BY mended_at DESC, rowid DESC LIMIT 1", s.WorldID).Scan(&lastMended)

			rows, err := tx.QueryContext(ctx, "SELECT repair_id, mended_at FROM village_repairs WHERE world_id=?", s.WorldID)
			if err != nil {
				return out, err
			}
			isOpen := map[string]bool{}
			known := map[string]bool{}
			mendedAt := map[string]int64{}
			for rows.Next() {
				var rid string
				var mAt sql.NullInt64
				if err = rows.Scan(&rid, &mAt); err != nil {
					rows.Close()
					return out, err
				}
				known[rid] = true
				if mAt.Valid {
					mendedAt[rid] = mAt.Int64
				} else {
					isOpen[rid] = true
				}
			}
			rows.Close()
			if err = rows.Err(); err != nil {
				return out, err
			}

			day := content.CalendarAt(content.CalendarRules, now)
			// A break goes in with the weather: at most one new one per
			// wick (the clock), never a festival chore, which breaks on
			// its own day (the hame before Carting Day) without spending
			// the weather's allowance.
			openBreak := func(def content.RepairDef) error {
				// First time it breaks, or it's mended and rots again: the
				// row is reset, the log keeps the history.
				if known[def.ID] {
					if _, err := tx.ExecContext(ctx, "UPDATE village_repairs SET mended_by=NULL, mended_at=NULL, created_at=? WHERE world_id=? AND repair_id=? AND mended_at IS NOT NULL", now, s.WorldID, def.ID); err != nil {
						return err
					}
				} else if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO village_repairs(world_id, repair_id, created_at) VALUES(?, ?, ?)", s.WorldID, def.ID, now); err != nil {
					return err
				}
				isOpen[def.ID] = true
				currentOpen++
				return nil
			}

			if lastBreakWick+int64(perWick) <= wick {
				// What breaks next: the least-recently-mended of the pool —
				// a chore that never broke yet comes first — so weather
				// works through the list instead of wearing one chore.
				// Never the same thing twice in a row (the last mend sits
				// out), and never what weather can't take (the well: water
				// is a dependency, not a chore).
				var pick *content.RepairDef
				var pickMended int64 = -1
				for i, def := range content.RepairRules.Repairs {
					if currentOpen >= maxOpen {
						break
					}
					if !def.WeatherTakes() || def.OpenFrom != nil || isOpen[def.ID] || def.ID == lastMended {
						continue
					}
					mAt := int64(-1)
					if known[def.ID] {
						mAt = mendedAt[def.ID]
					}
					if pick == nil || mAt < pickMended {
						pick = &content.RepairRules.Repairs[i]
						pickMended = mAt
					}
				}
				if pick != nil {
					if err = openBreak(*pick); err != nil {
						return out, err
					}
					// One breakage per read; the clock paces the rest by wick.
					if _, err = tx.ExecContext(ctx, "UPDATE village_repair_clock SET last_break_wick=? WHERE world_id=?", wick, s.WorldID); err != nil {
						return out, err
					}
				}
			}

			// Festival chores break on their day, whatever the weather did.
			for _, def := range content.RepairRules.Repairs {
				if currentOpen >= maxOpen {
					break
				}
				if def.OpenFrom == nil || isOpen[def.ID] || def.ID == lastMended {
					continue
				}
				if day.Wick != def.OpenFrom.Wick || day.Day < def.OpenFrom.Day {
					continue
				}
				if err = openBreak(def); err != nil {
					return out, err
				}
			}
		}
	}

	// 2. Query open repairs
	openRows, err := tx.QueryContext(ctx, "SELECT repair_id FROM village_repairs WHERE world_id=? AND mended_at IS NULL ORDER BY created_at", s.WorldID)
	if err != nil {
		return out, err
	}
	defer openRows.Close()
	for openRows.Next() {
		var id string
		if err = openRows.Scan(&id); err != nil {
			return out, err
		}
		def, ok := content.RepairFor(id)
		if !ok {
			continue
		}
		out.Open = append(out.Open, choreView{
			ID:          def.ID,
			Name:        def.Name,
			Part:        def.Part,
			Area:        def.Area,
			Target:      def.Target,
			Pos:         def.Pos,
			Resident:    def.Resident,
			Hint:        def.Hint,
			Description: def.Description,
		})
	}
	if err = openRows.Err(); err != nil {
		return out, err
	}

	// 3. Query mended repairs
	mendedRows, err := tx.QueryContext(ctx, `
		SELECT vr.repair_id, vr.mended_by, coalesce(p.display_name, ''), vr.mended_at
		FROM village_repairs vr
		LEFT JOIN players p ON p.account_id = vr.mended_by
		WHERE vr.world_id = ? AND vr.mended_at IS NOT NULL
		ORDER BY vr.mended_at
	`, s.WorldID)
	if err != nil {
		return out, err
	}
	defer mendedRows.Close()
	for mendedRows.Next() {
		var mv mendedView
		var by sql.NullString
		if err = mendedRows.Scan(&mv.RepairID, &by, &mv.DisplayName, &mv.MendedAt); err != nil {
			return out, err
		}
		mv.MendedBy = by.String
		mv.DisplayName = capDonor(mv.DisplayName)
		out.Mended = append(out.Mended, mv)
		def, ok := content.RepairFor(mv.RepairID)
		if ok {
			out.WorldFlags = append(out.WorldFlags, def.WorldFlag)
		} else {
			out.WorldFlags = append(out.WorldFlags, "repair:"+mv.RepairID+":mended")
		}
	}
	if err = mendedRows.Err(); err != nil {
		return out, err
	}

	// 4. Query recent history
	histRows, err := tx.QueryContext(ctx, `
		SELECT l.id, l.repair_id, l.mended_by, coalesce(p.display_name, ''), l.mended_at
		FROM village_repair_log l
		LEFT JOIN players p ON p.account_id = l.mended_by
		WHERE l.world_id = ?
		ORDER BY l.mended_at DESC
		LIMIT 5
	`, s.WorldID)
	if err != nil {
		return out, err
	}
	defer histRows.Close()
	for histRows.Next() {
		var h choreHistoryView
		if err = histRows.Scan(&h.ID, &h.RepairID, &h.MendedBy, &h.DisplayName, &h.MendedAt); err != nil {
			return out, err
		}
		h.DisplayName = capDonor(h.DisplayName)
		if def, ok := content.RepairFor(h.RepairID); ok {
			h.RepairName = def.Name
		} else {
			h.RepairName = h.RepairID
		}
		out.History = append(out.History, h)
	}
	return out, histRows.Err()
}

func (a *Server) repairsRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := a.Config.Now().Unix()
	v, err := readRepairs(r.Context(), tx, s, now)
	if err != nil {
		return err
	}
	return a.finishRead(w, r, tx, s, repairsViewProto(v))
}

func (a *Server) repairMend(w http.ResponseWriter, r *http.Request) error {
	id, err := pathActionID(r.URL.Path, "/api/repairs/", "/mend")
	if err != nil {
		return err
	}
	var req contract.MendRequest
	if err = decodeOp(w, r, &req); err != nil {
		return err
	}

	return a.keyedOp(w, r, req.Op, req.Where, &req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		def, ok := content.RepairFor(id)
		if !ok {
			return nil, fail(404, "repair-not-found")
		}

		// Ensure repair state
		var mendedAt sql.NullInt64
		err := tx.QueryRowContext(ctx, "SELECT mended_at FROM village_repairs WHERE world_id=? AND repair_id=?", s.WorldID, id).Scan(&mendedAt)
		if err == sql.ErrNoRows {
			if id == "well-rope" {
				if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO village_repairs(world_id, repair_id, created_at) VALUES(?, 'well-rope', ?)", s.WorldID, now); err != nil {
					return nil, err
				}
			} else {
				// Not yet opened in this world
				return nil, fail(409, "repair-not-open")
			}
		} else if err != nil {
			return nil, err
		}
		if mendedAt.Valid {
			return nil, fail(409, "already-mended")
		}

		// Proximity check (must be near broken thing)
		if !nearTile(s, def.Area, def.Pos.TX, def.Pos.TY, 4) {
			return nil, fail(409, "too-far-away")
		}

		// Take the required part from player pack
		ref := s.WorldID + ":" + id
		if _, err = packTake(ctx, tx, s.AccountID, def.Part, nil, 1, "village-repair", ref, now); err != nil {
			return nil, err
		}

		// Mark mended in village_repairs
		if _, err = tx.ExecContext(ctx, `
			UPDATE village_repairs
			SET mended_by = ?, mended_at = ?
			WHERE world_id = ? AND repair_id = ? AND mended_at IS NULL
		`, s.AccountID, now, s.WorldID, id); err != nil {
			return nil, err
		}

		// Insert into log
		logID, err := store.Random()
		if err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, `
			INSERT INTO village_repair_log(id, world_id, repair_id, mended_by, mended_at)
			VALUES(?, ?, ?, ?, ?)
		`, logID, s.WorldID, id, s.AccountID, now); err != nil {
			return nil, err
		}

		// Optional reward gift: its ledger row must land with the mend.
		if def.Gift != nil {
			if err = packPut(ctx, tx, s.AccountID, def.Gift.ID, []makerQty{{Maker: "", Qty: def.Gift.Qty}}, "village-reward", ref, now); err != nil {
				return nil, err
			}
		}

		// The scripted chores teach mending once; the weather starts the
		// wick after the last of them is mended (it only ever sets this if
		// it never started — the clock is not rewound later).
		if slices.Contains(content.RepairRules.Rules.Scripted, id) {
			wick := content.CalendarAt(content.CalendarRules, now).WickNumber
			if _, err = tx.ExecContext(ctx, `
				INSERT INTO village_repair_clock(world_id, last_break_wick) VALUES(?, ?)
				ON CONFLICT(world_id) DO UPDATE SET last_break_wick=excluded.last_break_wick
				WHERE last_break_wick = 0
			`, s.WorldID, wick); err != nil {
				return nil, err
			}
		}

		if err = refreshItems(ctx, tx, s); err != nil {
			return nil, err
		}

		v, err := readRepairs(ctx, tx, *s, now)
		if err != nil {
			return nil, err
		}
		items, err := readItems(ctx, tx, s, now)
		if err != nil {
			return nil, err
		}

		out := &contract.MendResult{Mended: id, Reaction: def.Reaction, Repairs: repairsViewProto(v), Items: itemsViewProto(items)}
		if def.Gift != nil {
			out.Gift = &contract.RepairGift{Kind: def.Gift.Kind, Id: def.Gift.ID, Qty: int32(def.Gift.Qty)}
		}
		return out, nil
	})
}
