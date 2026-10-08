package store

import (
	"context"
	"database/sql"
	"glimway/content"
	"glimway/server/internal/rules"
	"strings"
)

// Keep the shipped doorsteps when a room's authored row is retired. New
// retired rooms should retain their last doorstep here before deleting data.
var retiredRoomDoors = map[string]content.RoomTile{
	"in:village:bakery":  {TX: 7, TY: 8},
	"in:village:mill":    {TX: 29, TY: 23},
	"in:village:library": {TX: 4, TY: 18},
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
		for _, door := range room.Doors {
			if door.To == area {
				// The staircase tiles remain on the parent map.
				for y, row := range room.Map {
					if x := strings.Index(row, door.At); x >= 0 {
						next, position = parent, rules.Position{X: float64(x*16 + 8), Y: float64(y*16 + 8)}
						break
					}
				}
			}
		}
		if next != parent {
			for y, row := range room.Map {
				if x := strings.Index(row, "@"); x >= 0 {
					next, position = parent, rules.Position{X: float64(x*16 + 8), Y: float64(y*16 + 8)}
				}
			}
		}
	} else {
		// A surviving floor may retain the building's front-door metadata.
		for _, room := range content.RoomRules.Rooms {
			if content.RootArea(room.ID) != parent || content.RoomParent(room.ID) != area {
				continue
			}
			for _, door := range room.Doors {
				if door.To == parent && door.Outside != nil {
					next, position = parent, rules.Position{X: float64(door.Entry.TX*16 + 8), Y: float64(door.Entry.TY*16 + 8)}
				}
			}
		}
		if door, ok := retiredRoomDoors[strings.TrimSuffix(area, ":2")]; ok && position == rules.NewState().Position {
			next, position = "village", rules.Position{X: float64(door.TX*16 + 8), Y: float64(door.TY*16 + 8)}
		}
	}
	if err := BumpVersion(ctx, tx, s); err != nil {
		return err
	}
	s.State.Area, s.State.Position = next, position
	_, err := tx.ExecContext(ctx, "UPDATE player_place SET area=?,x=?,y=?,place_set_version=?,last_outer_epoch='',last_outer_starts_at=NULL WHERE account_id=?", next, position.X, position.Y, s.Version, s.AccountID)
	return err
}
