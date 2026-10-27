package wilds

import "context"

// SlopeSurfacer makes a canonical SlopeSurface for a rectangle of world
// tiles. Every recipe answers through the same surface and contract
// (1/256 corners, levels 0–15, the per-corner walk rule, kinds, corner
// ownership), so a client never needs to know which recipe it reads.
type SlopeSurfacer interface {
	Surface(ctx context.Context, x, y, w, h int) (*SlopeSurface, error)
}

// SlopeRecipeFor is a recipe's sampler by id (slopes-gen@1, the placeholder
// bars; slopes-gen@2, natural ranges), or an error for an unknown id. The
// dev terrain route (server/internal/api/dev_terrain.go) picks one by id.
func SlopeRecipeFor(seed, recipe string) (SlopeSurfacer, error) {
	return NewSlopeSamplerRecipe(seed, recipe)
}
