package api

// Boundary converters for the village domains (village.proto): the internal
// row-scan views become the generated wire messages at the emit boundary,
// the way worldChoiceView does for the world choice. Answers only ever
// leave through protojson. The goods views' converters (assetProto,
// countsProto, homeViewProto, …) are homestead_wire.go's, shared now that
// the messages live in goods.proto.

import (
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// workshopProto is the storage read's and move's result.
func workshopProto(v workshopView) *contract.WorkshopView {
	out := &contract.WorkshopView{Inventory: countsProto(v.Inventory), Personal: countsProto(v.Personal), Shared: v.Shared}
	if v.Home != nil {
		out.Home = homeViewProto(*v.Home)
	}
	if v.Storage != nil {
		out.Storage = countsProto(*v.Storage)
	}
	return out
}

// A craft answer repeats the workshop view's fields beside its own.
func fillWorkshop(out *contract.CraftResult, v workshopView) {
	out.Home, out.Inventory, out.Storage, out.Personal, out.Shared = workshopFields(v)
}

func fillHearthWorkshop(out *contract.HearthCraftResult, v workshopView) {
	out.Home, out.Inventory, out.Storage, out.Personal, out.Shared = workshopFields(v)
}

func fillDeskWorkshop(out *contract.DeskCopyResult, v workshopView) {
	out.Home, out.Inventory, out.Storage, out.Personal, out.Shared = workshopFields(v)
}

func workshopFields(v workshopView) (*contract.HomeView, *contract.AssetCounts, *contract.AssetCounts, *contract.AssetCounts, string) {
	w := workshopProto(v)
	return w.Home, w.Inventory, w.Storage, w.Personal, w.Shared
}

func personProto(v person) *contract.Person {
	return &contract.Person{Id: v.ID, Name: v.Name}
}

func mailViewProto(v mailView) *contract.MailView {
	out := &contract.MailView{Id: v.ID, WorldId: v.WorldID, FromId: v.FromID, ToId: v.ToID, FromName: v.FromName, ToName: v.ToName, Asset: assetProto(v.Asset), SentAt: float64(v.SentAt)}
	if v.ClaimedAt != nil {
		out.ClaimedAt = wrapperspb.Double(float64(*v.ClaimedAt))
	}
	if v.ReturnedAt != nil {
		out.ReturnedAt = wrapperspb.Double(float64(*v.ReturnedAt))
	}
	if v.ReturnReason != nil {
		out.ReturnReason = wrapperspb.String(*v.ReturnReason)
	}
	return out
}

// mailPageFields is a page's list and cursors, for a result message that
// repeats them flat.
func mailPageFields(v mailPage) ([]*contract.MailView, *wrapperspb.StringValue, *wrapperspb.StringValue) {
	var mail []*contract.MailView
	for _, m := range v.Mail {
		mail = append(mail, mailViewProto(m))
	}
	var next, nextPending *wrapperspb.StringValue
	if v.NextCursor != nil {
		next = wrapperspb.String(*v.NextCursor)
	}
	if v.NextPendingCursor != nil {
		nextPending = wrapperspb.String(*v.NextPendingCursor)
	}
	return mail, next, nextPending
}

func gateViewProto(v gateView) *contract.GateView {
	out := &contract.GateView{Gate: int32(v.Gate), Tier: int32(v.Tier), Desolate: v.Desolate, Mine: v.Mine, Reclaim: v.Reclaim, Shelf: v.Shelf, ShelfStocked: v.ShelfStocked}
	if v.HomeID != nil {
		out.HomeId = wrapperspb.String(*v.HomeID)
	}
	out.Names = append(out.Names, v.Names...)
	for _, m := range v.Members {
		out.Members = append(out.Members, homeMemberProto(m))
	}
	if v.Price != nil {
		out.Price = wrapperspb.Int32(int32(*v.Price))
	}
	return out
}

func inviteViewProto(v inviteView) *contract.DeedInvite {
	out := &contract.DeedInvite{HomeId: v.HomeID, Gate: int32(v.Gate), From: personProto(v.From), To: personProto(v.To), ExpiresAt: float64(v.ExpiresAt)}
	if v.FromConfirmedAt != nil {
		out.FromConfirmedAt = wrapperspb.Double(float64(*v.FromConfirmedAt))
	}
	if v.ToConfirmedAt != nil {
		out.ToConfirmedAt = wrapperspb.Double(float64(*v.ToConfirmedAt))
	}
	return out
}

func projectViewProto(v projectView) *contract.ProjectView {
	out := &contract.ProjectView{Id: v.ID, Name: v.Name, Stage: v.Stage, Required: materialCountsProto(v.Required), Contributed: materialCountsProto(v.Contributed), Mine: materialCountsProto(v.Mine)}
	if v.CompletedAt != nil {
		out.CompletedAt = wrapperspb.Double(float64(*v.CompletedAt))
	}
	if v.WorldFlag != nil {
		out.WorldFlag = wrapperspb.String(*v.WorldFlag)
	}
	out.GrantablePapers = append(out.GrantablePapers, v.GrantablePapers...)
	return out
}

func projectsViewProto(v projectsView) *contract.ProjectsResult {
	out := &contract.ProjectsResult{WorldFlags: append([]string{}, v.WorldFlags...), GrantablePapers: append([]string{}, v.GrantablePapers...)}
	for _, p := range v.Projects {
		out.Projects = append(out.Projects, projectViewProto(p))
	}
	return out
}

func choreViewProto(v choreView) *contract.ChoreView {
	return &contract.ChoreView{Id: v.ID, Name: v.Name, Part: v.Part, Area: v.Area, Target: v.Target, Pos: &contract.RepairPos{Tx: int32(v.Pos.TX), Ty: int32(v.Pos.TY)}, Resident: v.Resident, Hint: v.Hint, Description: v.Description}
}

func mendedViewProto(v mendedView) *contract.MendedView {
	return &contract.MendedView{RepairId: v.RepairID, MendedBy: v.MendedBy, DisplayName: v.DisplayName, MendedAt: float64(v.MendedAt)}
}

func choreHistoryProto(v choreHistoryView) *contract.ChoreHistoryView {
	return &contract.ChoreHistoryView{Id: v.ID, RepairId: v.RepairID, RepairName: v.RepairName, MendedBy: v.MendedBy, DisplayName: v.DisplayName, MendedAt: float64(v.MendedAt)}
}

func repairsViewProto(v repairsView) *contract.RepairsResult {
	out := &contract.RepairsResult{WorldFlags: append([]string{}, v.WorldFlags...)}
	for _, c := range v.Open {
		out.Open = append(out.Open, choreViewProto(c))
	}
	for _, m := range v.Mended {
		out.Mended = append(out.Mended, mendedViewProto(m))
	}
	for _, h := range v.History {
		out.History = append(out.History, choreHistoryProto(h))
	}
	return out
}
