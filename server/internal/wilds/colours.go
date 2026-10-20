package wilds

import "image/color"

// GroundColour is the shared diagnostic map palette. Unknown content grounds
// get a stable, visible colour, so adding a ground never paints it transparent.
func GroundColour(id string) color.RGBA {
	if c, ok := groundColours[id]; ok {
		return c
	}
	h := Hash("ground-colour", id)
	return color.RGBA{uint8(70 + h%140), uint8(70 + (h>>8)%140), uint8(70 + (h>>16)%140), 255}
}

var groundColours = map[string]color.RGBA{
	"woods": {38, 74, 42, 255}, "moss": {86, 128, 62, 255}, "verge": {150, 134, 90, 255},
	"path": {176, 150, 100, 255}, "trodden": {128, 98, 62, 255}, "road": {120, 120, 112, 255},
	"water": {40, 92, 140, 255}, "meadow": {146, 186, 92, 255}, "bank": {204, 186, 138, 255},
	"ford": {96, 150, 186, 255}, "paving": {160, 160, 160, 255}, "laid-stone": {180, 180, 190, 255},
	"laid-plank": {160, 120, 80, 255},
}
