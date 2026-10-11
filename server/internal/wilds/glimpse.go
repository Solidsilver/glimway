package wilds

// A glimpse past the drift (open-map.md 2.10, decision 22).

// Glimpse is a chunk's main land (the land at its centre tile, as the made
// chunk's Land) and whether the Wend's water crosses it, from the lands and
// river passes only (decision 22). It never makes a chunk.
func Glimpse(e EpochV3, cx, cy int) (land string, river bool) {
	if e.check() != nil {
		return "", false
	}
	w := newWorld(e)
	S := chunkSize()
	land = landName(w.landOne(cx*S+S/2, cy*S+S/2))
	return land, w.river != nil && w.river.crossesChunk(cx, cy)
}
