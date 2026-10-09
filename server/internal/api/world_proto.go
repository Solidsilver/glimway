package api

// Boundary converter for the world views (world.proto), the way
// worldChoiceView does for the world choice.

import (
	contract "glimway/server/internal/gen/glimway/v1"
)

func worldRefProto(v worldRef) *contract.WorldRef {
	return &contract.WorldRef{Id: v.ID, OwnerId: v.OwnerID, OwnerName: v.OwnerName, Members: float64(v.Members), OwnerHere: v.OwnerHere, Party: v.Party}
}

func leavingProto(v leavingView) *contract.WorldLeaving {
	return &contract.WorldLeaving{Gate: int32(v.Gate), Last: v.Last, Outgoing: int32(v.Outgoing), Incoming: int32(v.Incoming), WardenTools: int32(v.WardenTools), DeedCost: int32(v.DeedCost)}
}

func leaverProto(v leaverView) *contract.WorldLeaver {
	return &contract.WorldLeaver{LeftAt: float64(v.LeftAt), MoveOutAt: float64(v.MoveOutAt), MoveOutIn: float64(v.MoveOutIn), HasOwn: v.HasOwn}
}

func worldViewProto(v worldView) *contract.WorldView {
	out := &contract.WorldView{World: worldRefProto(v.World), IsOwner: v.IsOwner, InParty: v.InParty, PartyHome: v.PartyHome, PartyCanOpen: v.PartyCanOpen, Prompt: v.Prompt, Leaving: leavingProto(v.Leaving), MoveOpensAt: float64(v.MoveOpensAt), MoveOpensIn: float64(v.MoveOpensIn), MovedOutAt: float64(v.MovedOutAt)}
	if v.PartyWorld != nil {
		out.PartyWorld = worldRefProto(*v.PartyWorld)
	}
	if v.OwnWorld != nil {
		out.OwnWorld = worldRefProto(*v.OwnWorld)
	}
	if v.Leaver != nil {
		out.Leaver = leaverProto(*v.Leaver)
	}
	return out
}
