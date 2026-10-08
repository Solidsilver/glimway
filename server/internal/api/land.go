package api

// Homestead land, served (server-first.md 3.4): the server generates each
// gate's wild land and the client draws what it's sent.

import (
	"context"
	"database/sql"
	"errors"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/land"
	"net/http"
	"strings"

	"glimway/server/internal/rules"
)

// LandGeneratorVersion versions the served land geometry (HomesteadLand).
const LandGeneratorVersion = 2

// Land is a gate's land in the caller's world (ports.HomeLandSource). Gates
// past the world's gate count are sql.ErrNoRows.
func (w wildsService) Land(ctx context.Context, tx *sql.Tx, world string, gate int32) (*contract.HomesteadLand, error) {
	n, err := gateCount(ctx, tx, world)
	if err != nil {
		return nil, err
	}
	if gate < 0 || int(gate) >= n {
		return nil, sql.ErrNoRows
	}
	cfg := content.HomeRules.Land
	l := land.Generate(land.Seed(world, int(gate), cfg), cfg)
	out := &contract.HomesteadLand{Width: uint32(l.Width), Height: uint32(l.Height), GeneratorVersion: LandGeneratorVersion, Cells: make([]string, len(l.Tiles))}
	for i, k := range l.Tiles {
		out.Cells[i] = land.CellNames[k]
	}
	return out, nil
}

// GET /api/homestead/land/<gate>
func (a *Server) landRead(w http.ResponseWriter, r *http.Request) error {
	gate := rules.HomeGate("home:" + strings.TrimPrefix(r.URL.Path, "/api/homestead/land/"))
	if gate < 0 {
		return fail(404, "invalid-gate")
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	view, err := a.Config.HomeLand.Land(r.Context(), tx, s.WorldID, int32(gate))
	if errors.Is(err, sql.ErrNoRows) {
		return fail(404, "invalid-gate")
	}
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	writeProto(w, 200, view)
	return nil
}
