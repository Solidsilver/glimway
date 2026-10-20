package wilds

import (
	"sync"

	"glimway/content"
)

// ConfigureForTools installs validated rules and rebuilds the generator's
// content-derived vocabulary. It is for standalone tools only: call once at
// process startup, before any generation or concurrent readers. Servers must
// continue using their frozen embedded content. A fresh worker process per
// content version prevents caches and concurrent requests from mixing rules.
func ConfigureForTools(raw []byte) error {
	rules, err := content.DecodeWilds(raw)
	if err != nil {
		return err
	}
	content.WildsRules = rules
	GroundIDs, groundRank = loadGroundIDs(), loadGroundRank()
	GroundWoods, GroundMoss, GroundVerge = groundID("woods"), groundID("moss"), groundID("verge")
	GroundPath, GroundTrodden, GroundRoad, GroundWater = groundID("path"), groundID("trodden"), groundID("road"), groundID("water")
	DecorKinds, DecorArts = loadDecorKinds(), loadDecorArts()
	DecorOak, DecorPine, DecorBirch = decorID("oak"), decorID("pine"), decorID("birch")
	DecorIronOak, DecorSnag, DecorThicket = decorID("iron-oak"), decorID("snag"), decorID("thicket")
	DecorStump, DecorRingStump, DecorLog = decorID("stump"), decorID("ring-stump"), decorID("log")
	DecorBoulder, DecorCairn, DecorFern = decorID("boulder"), decorID("cairn"), decorID("fern")
	DecorGrass, DecorFlowers, DecorTurncaps = decorID("grass"), decorID("flowers"), decorID("turncaps")
	DecorReeds, DecorRoots, DecorLitter, DecorPebbles = decorID("reeds"), decorID("roots"), decorID("litter"), decorID("pebbles")
	landGround, groundSurface, groundByTerrain = loadLandGround(), loadGroundSurface(), loadGroundByTerrain()
	groundRiverWater, groundRiverBank, groundRiverFord = groundID(rules.River.GetWaterGround()), groundID(rules.River.GetBankGround()), groundID(rules.River.GetFordGround())
	groundPaving, groundRoadVerge = groundID(rules.Road.GetGround()), groundID(rules.Road.GetVergeGround())
	maxClearing, landmarkKinds = loadMaxClearing(), loadLandmarkKinds()
	riverLeanLand = landIndex(rules.River.GetLeanLand())
	sideWoods, sideMeadow = landIndex("woods"), landIndex("meadow")
	seams = sync.OnceValue(loadSeams)
	return nil
}

// RoadCrossings reports conservative chunk bounds of the Lantern Road's
// paved ribbon (segment bounding boxes may include a corner the road misses).
// Like Glimpses, it reads only the macro plan and never generates chunks.
func RoadCrossings(e Epoch, chunks [][2]int) []bool {
	out := make([]bool, len(chunks))
	if e.check() != nil {
		return out
	}
	r := newRoad(e.WorldSeed)
	S := chunkSize()
	for i, c := range chunks {
		b := tileBox(c[0]*S, c[1]*S, (c[0]+1)*S-1, (c[1]+1)*S-1)
		for _, segment := range r.line.boxes {
			if segment.meets(b) {
				out[i] = true
				break
			}
		}
	}
	return out
}

// LandAt samples the lasting land field at a world tile without generating a
// chunk. Use a wick epoch for the full geography (including river lean).
func LandAt(e Epoch, tx, ty int) string {
	if e.check() != nil {
		return ""
	}
	return landName(newWorld(e).landOne(tx, ty))
}
