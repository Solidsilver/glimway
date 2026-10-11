package wilds

// A glimpse past the drift (open-map.md 2.10, decision 22).

// Glimpse is a chunk's main land (the land at its centre tile, as the made
// chunk's Land) and whether the Wend's water crosses it, from the lands and
// river passes only (decision 22). It never makes a chunk.
func Glimpse(e Epoch, cx, cy int) (land string, river bool) {
	if e.check() != nil {
		return "", false
	}
	return newWorld(e).glimpse(cx, cy)
}

// GlimpseOf is one chunk's glimpse.
type GlimpseOf struct {
	CX, CY int
	Land   string
	River  bool
}

// Glimpses is Glimpse for many chunks of one epoch, from one world (the
// near read asks for up to ~16 at once; a world costs ~0.1 ms to build).
func Glimpses(e Epoch, chunks [][2]int) []GlimpseOf {
	out := make([]GlimpseOf, len(chunks))
	if e.check() != nil {
		return out
	}
	w := newWorld(e)
	for i, c := range chunks {
		land, river := w.glimpse(c[0], c[1])
		out[i] = GlimpseOf{CX: c[0], CY: c[1], Land: land, River: river}
	}
	return out
}

func (w *world) glimpse(cx, cy int) (string, bool) {
	S := chunkSize()
	return landName(w.landOne(cx*S+S/2, cy*S+S/2)), w.river != nil && w.river.crossesChunk(cx, cy)
}
