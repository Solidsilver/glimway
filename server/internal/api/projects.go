package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"glimway/content"
	"glimway/server/internal/store"
	"net/http"
	"slices"
)

type projectView struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Stage       string         `json:"stage"`
	Required    map[string]int `json:"required"`
	Contributed map[string]int `json:"contributed"`
	// Mine is the caller's own running contribution per material.
	Mine            map[string]int `json:"mine"`
	CompletedAt     *int64         `json:"completedAt"`
	WorldFlag       *string        `json:"worldFlag"`
	GrantablePapers []string       `json:"grantablePapers"`
}
type projectsView struct {
	Projects        []projectView `json:"projects"`
	WorldFlags      []string      `json:"worldFlags"`
	GrantablePapers []string      `json:"grantablePapers"`
}

func readProjects(ctx context.Context, tx *sql.Tx, s store.Snapshot) (projectsView, error) {
	out := projectsView{Projects: []projectView{}, WorldFlags: []string{}, GrantablePapers: []string{}}
	for _, def := range content.ProjectRules.Projects {
		v := projectView{ID: def.ID, Name: def.Name, Stage: "open", Required: def.Materials, Contributed: map[string]int{}, Mine: map[string]int{}, GrantablePapers: []string{}}
		for id := range def.Materials {
			v.Contributed[id] = 0
			v.Mine[id] = 0
		}
		mine, err := tx.QueryContext(ctx, "SELECT material,SUM(qty) FROM contributions WHERE world_id=? AND project_def=? AND habitica_id=? GROUP BY material", s.WorldID, def.ID, s.HabiticaID)
		if err != nil {
			return out, err
		}
		for mine.Next() {
			var id string
			var n int
			if err = mine.Scan(&id, &n); err != nil {
				mine.Close()
				return out, err
			}
			v.Mine[id] = n
		}
		err = mine.Err()
		mine.Close()
		if err != nil {
			return out, err
		}
		err = tx.QueryRowContext(ctx, "SELECT completed_at,world_flag FROM projects WHERE world_id=? AND project_def=?", s.WorldID, def.ID).Scan(&v.CompletedAt, &v.WorldFlag)
		if err != nil && err != sql.ErrNoRows {
			return out, err
		}
		rows, err := tx.QueryContext(ctx, "SELECT material,qty FROM project_materials WHERE world_id=? AND project_def=?", s.WorldID, def.ID)
		if err != nil {
			return out, err
		}
		for rows.Next() {
			var id string
			var n int
			if err = rows.Scan(&id, &n); err != nil {
				rows.Close()
				return out, err
			}
			v.Contributed[id] = n
			v.Stage = "in-progress"
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return out, err
		}
		if v.CompletedAt != nil {
			v.Stage = "complete"
			out.WorldFlags = append(out.WorldFlags, *v.WorldFlag)
			rows, err = tx.QueryContext(ctx, `SELECT paper_id FROM project_papers WHERE world_id=? AND project_def=? AND EXISTS(SELECT 1 FROM contributions WHERE world_id=? AND project_def=? AND habitica_id=?) ORDER BY paper_id`, s.WorldID, def.ID, s.WorldID, def.ID, s.HabiticaID)
			if err != nil {
				return out, err
			}
			for rows.Next() {
				var id string
				if err = rows.Scan(&id); err != nil {
					rows.Close()
					return out, err
				}
				v.GrantablePapers = append(v.GrantablePapers, id)
				out.GrantablePapers = append(out.GrantablePapers, id)
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return out, err
			}
		}
		out.Projects = append(out.Projects, v)
	}
	slices.Sort(out.GrantablePapers)
	return out, nil
}
func (a *Server) projectsRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, def := range content.ProjectRules.Projects {
		if err = completeProject(r.Context(), tx, s.WorldID, def, a.Config.Now().Unix()); err != nil {
			return err
		}
	}
	v, err := readProjects(r.Context(), tx, s)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		projectsView
	}{s, v})
}
func (a *Server) projectContribute(w http.ResponseWriter, r *http.Request) error {
	id, err := pathActionID(r.URL.Path, "/api/projects/", "/contribute")
	if err != nil {
		return err
	}
	var req struct {
		Mutation
		Key       string          `json:"key"`
		Progress  json.RawMessage `json:"progress,omitempty"`
		Materials map[string]int  `json:"materials"`
	}
	if err = decode(w, r, &req); err != nil {
		return err
	}
	return a.keyedMutation(w, r, req.Mutation, req.Key, req, req.Progress, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		def, ok := content.ProjectFor(id)
		if !ok {
			return nil, fail(404, "project-not-found")
		}
		if len(req.Materials) == 0 || len(req.Materials) > len(def.Materials) {
			return nil, fail(400, "invalid-contribution")
		}
		for material, n := range req.Materials {
			if def.Materials[material] == 0 || n < 1 || n > 10000 {
				return nil, fail(400, "invalid-contribution")
			}
		}
		if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO projects(world_id,project_def) VALUES(?,?)", s.WorldID, id); err != nil {
			return nil, err
		}
		var completed sql.NullInt64
		if err := tx.QueryRowContext(ctx, "SELECT completed_at FROM projects WHERE world_id=? AND project_def=?", s.WorldID, id).Scan(&completed); err != nil {
			return nil, err
		}
		if completed.Valid {
			return nil, fail(409, "project-complete")
		}
		ref, err := store.Random()
		if err != nil {
			return nil, err
		}
		for _, material := range content.WildsRules.Materials {
			n := req.Materials[material]
			if n == 0 {
				continue
			}
			var current int
			err = tx.QueryRowContext(ctx, "SELECT qty FROM project_materials WHERE world_id=? AND project_def=? AND material=?", s.WorldID, id, material).Scan(&current)
			if err != nil && err != sql.ErrNoRows {
				return nil, err
			}
			if n > max(0, def.Materials[material]-current) {
				return nil, fail(409, "project-overfilled")
			}
			if err = materialChange(ctx, tx, s.HabiticaID, material, -n, "project-contribute", s.WorldID+":"+id+":"+ref, now); err != nil {
				return nil, err
			}
			if _, err = tx.ExecContext(ctx, "INSERT INTO project_materials VALUES(?,?,?,?) ON CONFLICT(world_id,project_def,material) DO UPDATE SET qty=qty+excluded.qty", s.WorldID, id, material, n); err != nil {
				return nil, err
			}
			contribution, err := store.Random()
			if err != nil {
				return nil, err
			}
			if _, err = tx.ExecContext(ctx, "INSERT INTO contributions VALUES(?,?,?,?,?,?,?)", contribution, s.WorldID, id, s.HabiticaID, material, n, now); err != nil {
				return nil, err
			}
		}
		if err = completeProject(ctx, tx, s.WorldID, def, now); err != nil {
			return nil, err
		}
		v, err := readProjects(ctx, tx, *s)
		if err != nil {
			return nil, err
		}
		m, err := materials(ctx, tx, s.HabiticaID)
		if err != nil {
			return nil, err
		}
		return struct {
			projectsView
			ProjectID string         `json:"projectId"`
			Materials map[string]int `json:"materials"`
		}{v, id, m}, nil
	})
}

// Reconcile tuned requirements against durable totals without changing any
// player revision. Existing completion records and paper grants remain frozen.
func completeProject(ctx context.Context, tx *sql.Tx, world string, def content.Project, now int64) error {
	for material, required := range def.Materials {
		var n int
		err := tx.QueryRowContext(ctx, "SELECT qty FROM project_materials WHERE world_id=? AND project_def=? AND material=?", world, def.ID, material).Scan(&n)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		if n < required {
			return nil
		}
	}
	res, err := tx.ExecContext(ctx, "UPDATE projects SET completed_at=?,world_flag=? WHERE world_id=? AND project_def=? AND completed_at IS NULL", now, def.WorldFlag, world, def.ID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil || n == 0 {
		return err
	}
	for _, paper := range def.Papers {
		if _, err = tx.ExecContext(ctx, "INSERT INTO project_papers VALUES(?,?,?,?)", world, def.ID, paper, now); err != nil {
			return err
		}
	}
	return nil
}
