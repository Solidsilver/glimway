package store

import (
	"context"
	"database/sql"
	"glimway/content"
	"glimway/server/internal/location"
	"glimway/server/internal/rules"
	"math"
	"strings"

	"google.golang.org/protobuf/proto"
)

// Keep the shipped doorsteps when a room's authored row is retired. New
// retired rooms should retain their last doorstep here before deleting data.
var retiredRoomDoors = map[string]*content.RoomTile{
	"in:village:bakery":  {Tx: proto.Int32(7), Ty: proto.Int32(8)},
	"in:village:mill":    {Tx: proto.Int32(29), Ty: proto.Int32(23)},
	"in:village:library": {Tx: proto.Int32(4), Ty: proto.Int32(18)},
}

// commonsFallback is where a removed Commons room with no surviving door
// lands: the arch, as the Commons fallback (location-seam.md §3).
const commonsFallback = "commons:arch"

// onGrid carries a place on a fixed footprint's layout ("commons", the door
// metadata's frame) into its space: outdoors, by the footprint's origin.
// Any other area is returned unchanged.
func onGrid(area string, p rules.Position) (string, rules.Position) {
	tx, ty := int(math.Floor(p.X/16)), int(math.Floor(p.Y/16))
	space, wx, wy := location.Resolve(area, tx, ty)
	return string(space), rules.Position{X: p.X + float64((wx-tx)*16), Y: p.Y + float64((wy-ty)*16)}
}

// Recover removed rooms on reads too, before projecting a saved place.
func recoverRoom(ctx context.Context, tx *sql.Tx, s *Snapshot) error {
	area := s.State.Area
	if !strings.HasPrefix(area, "in:") || content.KnownRoom(area) {
		return nil
	}
	parent := content.RoomParent(area)
	next, position := "village", rules.NewState().Position
	if room, ok := content.RoomFor(parent); ok {
		for _, door := range room.GetDoors() {
			if door.GetTo() == area {
				// The staircase tiles remain on the parent map.
				for y, row := range room.GetMap() {
					if x := strings.Index(row, door.At); x >= 0 {
						next, position = parent, rules.Position{X: float64(x*16 + 8), Y: float64(y*16 + 8)}
						break
					}
				}
			}
		}
		if next != parent {
			for y, row := range room.GetMap() {
				if x := strings.Index(row, "@"); x >= 0 {
					next, position = parent, rules.Position{X: float64(x*16 + 8), Y: float64(y*16 + 8)}
				}
			}
		}
	} else {
		// A surviving floor may retain the building's front-door metadata.
		for _, room := range content.RoomRules.Rooms {
			if content.RootArea(room.GetId()) != parent || content.RoomParent(room.GetId()) != area {
				continue
			}
			for _, door := range room.GetDoors() {
				if door.GetTo() == parent && door.Outside != nil {
					next, position = parent, rules.Position{X: float64(door.GetEntry().GetTx()*16 + 8), Y: float64(door.GetEntry().GetTy()*16 + 8)}
				}
			}
		}
		if door, ok := retiredRoomDoors[strings.TrimSuffix(area, ":2")]; ok && position == rules.NewState().Position {
			next, position = "village", rules.Position{X: float64(door.GetTx()*16 + 8), Y: float64(door.GetTy()*16 + 8)}
		}
		if next == "village" && position == rules.NewState().Position && content.RootArea(area) == "commons" {
			if space, x, y, ok := location.Anchor(commonsFallback); ok {
				next, position = string(space), rules.Position{X: x, Y: y}
			}
		}
	}
	next, position = onGrid(next, position)
	if err := BumpVersion(ctx, tx, s); err != nil {
		return err
	}
	s.State.Area, s.State.Position = next, position
	_, err := tx.ExecContext(ctx, "UPDATE player_place SET area=?,x=?,y=?,place_set_version=?,last_wick_epoch='',last_wick_starts_at=NULL WHERE account_id=?", next, position.X, position.Y, s.Version, s.AccountID)
	return err
}
