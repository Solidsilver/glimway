package api

// Boundary converters for the village domains (village.proto): the internal
// row-scan views become the generated wire messages at the emit boundary,
// the way worldChoiceView does for the world choice. Answers only ever leave
// through protojson.

import (
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/content"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

func assetProto(v content.Asset) *contract.Asset {
	out := &contract.Asset{Kind: v.Kind, Id: v.ID, Qty: int32(v.Qty), Instance: v.Instance}
	if v.Maker != nil {
		out.Maker = wrapperspb.String(*v.Maker)
	}
	return out
}

// assetFromProto is a request's goods, back in the domain's own shape.
func assetFromProto(v *contract.Asset) content.Asset {
	if v == nil {
		return content.Asset{}
	}
	out := content.Asset{Kind: v.GetKind(), ID: v.GetId(), Qty: int(v.GetQty()), Instance: v.GetInstance()}
	if v.Maker != nil {
		maker := v.Maker.Value
		out.Maker = &maker
	}
	return out
}

func makerViewProto(v *makerView) *contract.MakerView {
	if v == nil {
		return nil
	}
	return &contract.MakerView{Id: v.ID, Name: v.Name}
}

func fittingViewProto(v fittingView) *contract.FittingView {
	out := &contract.FittingView{Id: v.ID, ItemDef: v.ItemDef, Fitting: v.Fitting, Condition: int32(v.Condition), MaxCondition: int32(v.MaxCondition), UsesLeft: int32(v.UsesLeft), Maker: makerViewProto(v.Maker)}
	return out
}

func instanceViewProto(v instanceView) *contract.InstanceView {
	out := &contract.InstanceView{Id: v.ID, ItemDef: v.ItemDef, Condition: int32(v.Condition), MaxCondition: int32(v.MaxCondition), UsesLeft: int32(v.UsesLeft), State: v.State, WardenSet: v.WardenSet, Maker: makerViewProto(v.Maker)}
	if v.Dullness != nil {
		out.Dullness = wrapperspb.Double(*v.Dullness)
	}
	if v.Speed != nil {
		out.Speed = wrapperspb.Double(*v.Speed)
	}
	for _, f := range v.Fittings {
		out.Fittings = append(out.Fittings, fittingViewProto(f))
	}
	return out
}

func countsProto(v assetCounts) *contract.AssetCounts {
	out := &contract.AssetCounts{Materials: map[string]int32{}, Items: map[string]int32{}, Decorations: map[string]int32{}}
	for id, n := range v.Materials {
		out.Materials[id] = int32(n)
	}
	for id, n := range v.Items {
		out.Items[id] = int32(n)
	}
	for id, n := range v.Decorations {
		out.Decorations[id] = int32(n)
	}
	for _, i := range v.Instances {
		out.Instances = append(out.Instances, instanceViewProto(i))
	}
	return out
}

func homeMemberProto(v homeMember) *contract.HomeMember {
	return &contract.HomeMember{Id: v.ID, DisplayName: v.DisplayName}
}

func homeTileProto(t [2]int) *contract.HomeTile {
	return &contract.HomeTile{X: int32(t[0]), Y: int32(t[1])}
}

func homeInstanceProto(v homeInstance) *contract.HomeInstance {
	out := &contract.HomeInstance{Id: v.ID, ItemDef: v.ItemDef}
	if v.Scene != nil {
		out.Scene = wrapperspb.String(*v.Scene)
	}
	if v.X != nil {
		out.X = wrapperspb.Int32(int32(*v.X))
	}
	if v.Y != nil {
		out.Y = wrapperspb.Int32(int32(*v.Y))
	}
	if v.Rotation != nil {
		out.Rotation = wrapperspb.Int32(int32(*v.Rotation))
	}
	if v.Name != nil {
		out.Name = wrapperspb.String(*v.Name)
	}
	return out
}

func homePlantProto(v homePlantView) *contract.HomePlantView {
	out := &contract.HomePlantView{Id: v.ID, ItemDef: v.ItemDef, X: int32(v.X), Y: int32(v.Y), Lit: v.Lit}
	if v.PlantedAt != 0 {
		out.PlantedAt = wrapperspb.Double(float64(v.PlantedAt))
	}
	if v.PlantedDay != 0 {
		out.PlantedDay = wrapperspb.Double(float64(v.PlantedDay))
	}
	return out
}

func homeGridProto(v content.HomeGrid) *contract.HomeGrid {
	return &contract.HomeGrid{Width: int32(v.Width), Height: int32(v.Height)}
}

func homeViewProto(v homeView) *contract.HomeView {
	out := &contract.HomeView{Id: v.ID, Gate: int32(v.Gate), WorldId: v.WorldID, Tier: int32(v.Tier), Member: v.Member, Desolate: v.Desolate, LandSeed: v.LandSeed, PostsBought: int32(v.PostsBought)}
	for _, m := range v.Members {
		out.Members = append(out.Members, homeMemberProto(m))
	}
	if v.VacantSince != nil {
		out.VacantSince = wrapperspb.Double(float64(*v.VacantSince))
	}
	for _, t := range v.Cleared {
		out.Cleared = append(out.Cleared, homeTileProto(t))
	}
	for _, t := range v.Stumps {
		out.Stumps = append(out.Stumps, homeTileProto(t))
	}
	for _, p := range v.Plants {
		out.Plants = append(out.Plants, homePlantProto(p))
	}
	out.NextPost = map[string]int32{}
	for id, n := range v.NextPost {
		out.NextPost[id] = int32(n)
	}
	out.Outdoor = homeGridProto(v.Outdoor)
	if v.Indoor != nil {
		out.Indoor = homeGridProto(*v.Indoor)
	}
	for _, i := range v.Items {
		out.Items = append(out.Items, homeInstanceProto(i))
	}
	return out
}

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

func itemsViewProto(v itemsView) *contract.ItemsView {
	out := &contract.ItemsView{OffHand: &contract.OffHandView{Open: v.OffHand.Open}}
	for _, s := range v.Stacks {
		out.Stacks = append(out.Stacks, &contract.StackView{ItemDef: s.ItemDef, Qty: int32(s.Qty), Maker: makerViewProto(s.Maker)})
	}
	for _, i := range v.Instances {
		out.Instances = append(out.Instances, instanceViewProto(i))
	}
	for _, p := range v.Pockets {
		slot := &contract.SlotView{Slot: p.Slot}
		if p.ItemDef != nil {
			slot.ItemDef = wrapperspb.String(*p.ItemDef)
		}
		if p.Instance != nil {
			slot.Instance = wrapperspb.String(*p.Instance)
		}
		out.Pockets = append(out.Pockets, slot)
	}
	if v.OffHand.Class != nil {
		out.OffHand.Class = wrapperspb.String(*v.OffHand.Class)
	}
	if v.OffHand.ItemDef != nil {
		out.OffHand.ItemDef = wrapperspb.String(*v.OffHand.ItemDef)
	}
	if v.OffHand.Instance != nil {
		out.OffHand.Instance = wrapperspb.String(*v.OffHand.Instance)
	}
	out.PickedUp = append(out.PickedUp, v.PickedUp...)
	for _, t := range v.Thanks {
		out.Thanks = append(out.Thanks, &contract.ThanksView{FromName: t.FromName, ItemDef: t.ItemDef, At: float64(t.At)})
	}
	return out
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
	out := &contract.ProjectView{Id: v.ID, Name: v.Name, Stage: v.Stage, Required: map[string]int32{}, Contributed: map[string]int32{}, Mine: map[string]int32{}}
	for id, n := range v.Required {
		out.Required[id] = int32(n)
	}
	for id, n := range v.Contributed {
		out.Contributed[id] = int32(n)
	}
	for id, n := range v.Mine {
		out.Mine[id] = int32(n)
	}
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
