// Package frontier bounds generated outskirts around both the Wilds
// footprints and fixed town/plot ground. Rect bounds that union; Inside
// checks its actual shape (the outer corners are not all on the grid).
package frontier

import "glimway/server/internal/wilds"

func Inside(world string, cx, cy int) bool   { return wilds.InsideReach(cx, cy) }
func Rect(world string) (int, int, int, int) { return wilds.FrontierRect() }
