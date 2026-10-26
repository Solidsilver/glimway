package wilds

import "context"

// SlopeSurfacer makes a canonical SlopeSurface for a rectangle of world
// tiles. Every recipe answers through the same surface and contract
// (1/256 corners, levels 0–15, the per-corner walk rule, kinds, corner
// ownership), so a client never needs to know which recipe it reads.
type SlopeSurfacer interface {
	Surface(ctx context.Context, x, y, w, h int) (*SlopeSurface, error)
}

// SlopeRecipes are the height recipes a dev server can serve, by id. A new
// recipe (slopes-gen@2, natural ranges) is one more entry; the dev terrain
// route (server/internal/api/dev_terrain.go) picks one by id.
var SlopeRecipes = map[string]func(seed string) SlopeSurfacer{
	SlopeRecipe: func(seed string) SlopeSurfacer { return NewSlopeSampler(seed) },
}
