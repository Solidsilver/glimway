package content

import "testing"

func TestCraftingLoaderVectors(t *testing.T) {
	runLoaderVectors(t, "crafting", "crafting", func(raw []byte) (any, error) { return DecodeCrafting(raw) })
}

func TestProjectsLoaderVectors(t *testing.T) {
	runLoaderVectors(t, "projects", "projects", func(raw []byte) (any, error) { return DecodeProjects(raw) })
}
