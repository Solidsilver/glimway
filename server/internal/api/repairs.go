package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/store"
	"net/http"
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

	if fenceMended.Valid {
		// Rotate in weather-based breakages up to maxOpen
		var currentOpen int
		err = tx.QueryRowContext(ctx, "SELECT count(*) FROM village_repairs WHERE world_id=? AND mended_at IS NULL", s.WorldID).Scan(&currentOpen)
		if err != nil {
			return out, err
		}

		if currentOpen < maxOpen {
			// Find existing repair records in this world
			rows, err := tx.QueryContext(ctx, "SELECT repair_id, mended_at FROM village_repairs WHERE world_id=?", s.WorldID)
			if err != nil {
				return out, err
			}
			existing := map[string]bool{}
			isOpen := map[string]bool{}
			for rows.Next() {
				var rid string
				var mAt sql.NullInt64
				if err = rows.Scan(&rid, &mAt); err != nil {
					rows.Close()
					return out, err
				}
				existing[rid] = true
				if !mAt.Valid {
					isOpen[rid] = true
				}
			}
			rows.Close()

			// Last mended
			var lastMended string
			_ = tx.QueryRowContext(ctx, "SELECT repair_id FROM village_repair_log WHERE world_id=? ORDER BY mended_at DESC LIMIT 1", s.WorldID).Scan(&lastMended)

			for _, def := range content.RepairRules.Repairs {
				if currentOpen >= maxOpen {
					break
				}
				if isOpen[def.ID] || def.ID == lastMended {
					continue
				}
				// If not yet opened or already mended in the past, re-open if below maxOpen
				if !existing[def.ID] {
					if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO village_repairs(world_id, repair_id, created_at) VALUES(?, ?, ?)", s.WorldID, def.ID, now); err == nil {
						currentOpen++
						isOpen[def.ID] = true
					}
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
		LEFT JOIN players p ON p.habitica_id = vr.mended_by
		WHERE vr.world_id = ? AND vr.mended_at IS NOT NULL
		ORDER BY vr.mended_at
	`, s.WorldID)
	if err != nil {
		return out, err
	}
	defer mendedRows.Close()
	for mendedRows.Next() {
		var mv mendedView
		if err = mendedRows.Scan(&mv.RepairID, &mv.MendedBy, &mv.DisplayName, &mv.MendedAt); err != nil {
			return out, err
		}
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
		LEFT JOIN players p ON p.habitica_id = l.mended_by
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
	return a.finish(w, r, tx, struct {
		store.Snapshot
		repairsView
	}{s, v})
}

func (a *Server) repairMend(w http.ResponseWriter, r *http.Request) error {
	id, err := pathActionID(r.URL.Path, "/api/repairs/", "/mend")
	if err != nil {
		return err
	}
	var req struct {
		Mutation
		Key      string          `json:"key"`
		Progress json.RawMessage `json:"progress,omitempty"`
	}
	if err = decode(w, r, &req); err != nil {
		return err
	}

	return a.keyedMutation(w, r, req.Mutation, req.Key, req, req.Progress, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
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
			return nil, fail(400, "too-far-away")
		}

		// Take the required part from player pack
		ref := s.WorldID + ":" + id
		if _, err = packTake(ctx, tx, s.HabiticaID, def.Part, nil, 1, "village-repair", ref, now); err != nil {
			return nil, err
		}

		// Mark mended in village_repairs
		if _, err = tx.ExecContext(ctx, `
			UPDATE village_repairs
			SET mended_by = ?, mended_at = ?
			WHERE world_id = ? AND repair_id = ? AND mended_at IS NULL
		`, s.HabiticaID, now, s.WorldID, id); err != nil {
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
		`, logID, s.WorldID, id, s.HabiticaID, now); err != nil {
			return nil, err
		}

		// Optional reward gift
		if def.Gift != nil {
			_ = packPut(ctx, tx, s.HabiticaID, def.Gift.ID, []makerQty{{"", def.Gift.Qty}}, "village-reward", ref, now)
		}

		if err = refreshItems(ctx, tx, s); err != nil {
			return nil, err
		}

		v, err := readRepairs(ctx, tx, *s, now)
		if err != nil {
			return nil, err
		}
		items, err := readItems(ctx, tx, s)
		if err != nil {
			return nil, err
		}

		return struct {
			Repairs  repairsView         `json:"repairs"`
			Mended   string              `json:"mended"`
			Reaction string              `json:"reaction"`
			Gift     *content.RepairGift `json:"gift,omitempty"`
			Items    itemsView           `json:"items"`
		}{
			Repairs:  v,
			Mended:   id,
			Reaction: def.Reaction,
			Gift:     def.Gift,
			Items:    items,
		}, nil
	})
}
