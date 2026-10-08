package api

import (
	contract "glimway/server/internal/gen/glimway/v1"
)

func worldChoiceProto(v worldChoiceView) *contract.WorldChoice {
	out := &contract.WorldChoice{HabiticaId: v.HabiticaID, DisplayName: v.DisplayName, PartyCanOpen: v.PartyCanOpen, PartyAdmitted: v.PartyAdmitted}
	if w := v.PartyWorld; w != nil {
		out.PartyWorld = &contract.WorldRef{Id: w.ID, OwnerId: w.OwnerID, OwnerName: w.OwnerName, Members: float64(w.Members), OwnerHere: w.OwnerHere, Party: w.Party}
	}
	return out
}
