package api

// The homestead and items routes' wire layer: the internal domain views
// (homeView, itemsView, assetCounts…) are projected onto the generated
// contract messages (proto/glimway/v1/homestead.proto and items.proto) and
// marshaled for the mixed { state, result } envelope. Requests decode with
// decodeOp straight into the generated messages.

import (
	"encoding/json"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// protoResult marshals a typed domain result for the mixed envelope, with
// the same finite-number validation a typed envelope answer carries.
func protoResult(message proto.Message) (json.RawMessage, error) {
	if err := finiteProto(message.ProtoReflect()); err != nil {
		return nil, err
	}
	raw, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(message)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}

func gridProto(g content.HomeGrid) *contract.HomeGrid {
	return &contract.HomeGrid{Width: int32(g.Width), Height: int32(g.Height)}
}

// materialCountsProto copies the carried material counts (int) into the wire map.
func materialCountsProto(m map[string]int) map[string]int32 {
	out := make(map[string]int32, len(m))
	for k, n := range m {
		out[k] = int32(n)
	}
	return out
}

func makerProto(m *makerView) *contract.Maker {
	if m == nil {
		return nil
	}
	return &contract.Maker{Id: m.ID, Name: m.Name}
}

func assetProto(v content.Asset) *contract.Asset {
	out := &contract.Asset{Kind: v.Kind, Id: v.ID, Qty: int32(v.Qty), Instance: v.Instance}
	if v.Maker != nil {
		out.Maker = wrapperspb.String(*v.Maker)
	}
	return out
}

// assetOf converts a request's asset back to the domain shape.
func assetOf(a *contract.Asset) content.Asset {
	if a == nil {
		return content.Asset{}
	}
	v := content.Asset{Kind: a.Kind, ID: a.Id, Qty: int(a.Qty), Instance: a.Instance}
	if a.Maker != nil {
		maker := a.Maker.GetValue()
		v.Maker = &maker
	}
	return v
}

func instanceProto(v instanceView) *contract.Instance {
	out := &contract.Instance{
		Id: v.ID, ItemDef: v.ItemDef, Condition: float64(v.Condition), MaxCondition: float64(v.MaxCondition),
		UsesLeft: float64(v.UsesLeft), State: v.State, WardenSet: v.WardenSet, Maker: makerProto(v.Maker),
	}
	if v.Dullness != nil {
		out.Dullness = wrapperspb.Double(*v.Dullness)
	}
	if v.Speed != nil {
		out.Speed = wrapperspb.Double(*v.Speed)
	}
	out.Fittings = make([]*contract.Fitting, 0, len(v.Fittings))
	for _, f := range v.Fittings {
		out.Fittings = append(out.Fittings, &contract.Fitting{
			Id: f.ID, ItemDef: f.ItemDef, Fitting: f.Fitting, Condition: int32(f.Condition),
			MaxCondition: int32(f.MaxCondition), UsesLeft: int32(f.UsesLeft), Maker: makerProto(f.Maker),
		})
	}
	return out
}

func countsProto(c assetCounts) *contract.AssetCounts {
	out := &contract.AssetCounts{Materials: materialCountsProto(c.Materials), Items: materialCountsProto(c.Items), Decorations: materialCountsProto(c.Decorations)}
	out.Instances = make([]*contract.Instance, 0, len(c.Instances))
	for _, v := range c.Instances {
		out.Instances = append(out.Instances, instanceProto(v))
	}
	return out
}

func itemsViewProto(v itemsView) *contract.ItemsView {
	out := &contract.ItemsView{PickedUp: v.PickedUp}
	out.Stacks = make([]*contract.Stack, 0, len(v.Stacks))
	for _, s := range v.Stacks {
		out.Stacks = append(out.Stacks, &contract.Stack{ItemDef: s.ItemDef, Qty: int32(s.Qty), Maker: makerProto(s.Maker)})
	}
	out.Instances = make([]*contract.Instance, 0, len(v.Instances))
	for _, i := range v.Instances {
		out.Instances = append(out.Instances, instanceProto(i))
	}
	out.Pockets = make([]*contract.Slot, 0, len(v.Pockets))
	for _, p := range v.Pockets {
		slot := &contract.Slot{Slot: p.Slot}
		if p.ItemDef != nil {
			slot.ItemDef = wrapperspb.String(*p.ItemDef)
		}
		if p.Instance != nil {
			slot.Instance = wrapperspb.String(*p.Instance)
		}
		out.Pockets = append(out.Pockets, slot)
	}
	out.OffHand = &contract.OffHand{Open: v.OffHand.Open}
	if v.OffHand.Class != nil {
		out.OffHand.Class = wrapperspb.String(*v.OffHand.Class)
	}
	if v.OffHand.ItemDef != nil {
		out.OffHand.ItemDef = wrapperspb.String(*v.OffHand.ItemDef)
	}
	if v.OffHand.Instance != nil {
		out.OffHand.Instance = wrapperspb.String(*v.OffHand.Instance)
	}
	out.Thanks = make([]*contract.Thanks, 0, len(v.Thanks))
	for _, t := range v.Thanks {
		out.Thanks = append(out.Thanks, &contract.Thanks{FromName: t.FromName, ItemDef: t.ItemDef, At: float64(t.At)})
	}
	return out
}

func wearProto(w *wearResult) *contract.WearResult {
	if w == nil {
		return nil
	}
	out := &contract.WearResult{
		Broke: w.Broke, WoreOut: w.WoreOut, State: w.State, WornOut: w.WornOut, Returned: w.Returned,
		ItemDef: w.ItemDef, UsesLeft: float64(w.UsesLeft), Condition: float64(w.Condition), MakerId: w.MakerID,
	}
	if w.Instance != nil {
		out.Instance = instanceProto(*w.Instance)
	}
	return out
}

func coord(x, y int) *contract.Coord { return &contract.Coord{X: int32(x), Y: int32(y)} }

func coordList(t [][2]int) []*contract.Coord {
	out := make([]*contract.Coord, 0, len(t))
	for _, c := range t {
		out = append(out, coord(c[0], c[1]))
	}
	return out
}

func homeMemberProto(m homeMember) *contract.HomeMember {
	return &contract.HomeMember{Id: m.ID, DisplayName: m.DisplayName}
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

func homePlantProto(p homePlantView) *contract.HomePlant {
	return &contract.HomePlant{
		Id: p.ID, ItemDef: p.ItemDef, X: int32(p.X), Y: int32(p.Y),
		PlantedAt: float64(p.PlantedAt), PlantedDay: float64(p.PlantedDay), Lit: p.Lit,
	}
}

func homeViewProto(h homeView) *contract.HomeView {
	out := &contract.HomeView{
		Id: h.ID, Gate: int32(h.Gate), WorldId: h.WorldID, Tier: int32(h.Tier),
		Member: h.Member, Desolate: h.Desolate, LandSeed: h.LandSeed,
		PostsBought: int32(h.PostsBought), NextPost: materialCountsProto(h.NextPost),
		Outdoor: gridProto(h.Outdoor),
	}
	if h.VacantSince != nil {
		out.VacantSince = wrapperspb.Double(float64(*h.VacantSince))
	}
	if h.Indoor != nil {
		out.Indoor = gridProto(*h.Indoor)
	}
	out.Members = make([]*contract.HomeMember, 0, len(h.Members))
	for _, m := range h.Members {
		out.Members = append(out.Members, homeMemberProto(m))
	}
	out.Cleared = coordList(h.Cleared)
	out.Stumps = coordList(h.Stumps)
	out.Plants = make([]*contract.HomePlant, 0, len(h.Plants))
	for _, p := range h.Plants {
		out.Plants = append(out.Plants, homePlantProto(p))
	}
	out.Items = make([]*contract.HomeInstance, 0, len(h.Items))
	for _, i := range h.Items {
		out.Items = append(out.Items, homeInstanceProto(i))
	}
	return out
}

func shelfViewProto(v shelfView) *contract.ShelfView {
	out := &contract.ShelfView{
		Gate: int32(v.Gate), HomeId: v.HomeID, OwnerName: v.OwnerName, Names: v.Names,
		TakenToday: v.TakenToday, CanStock: v.CanStock, HasShelf: v.HasShelf,
	}
	out.Slots = make([]*contract.ShelfSlot, 0, len(v.Slots))
	for _, s := range v.Slots {
		slot := &contract.ShelfSlot{
			Slot: int32(s.Slot), Kind: s.Kind, ItemDef: s.ItemDef, Qty: int32(s.Qty),
			Maker: makerProto(s.Maker), StockedBy: s.StockedBy, StockedAt: float64(s.StockedAt),
		}
		if s.Instance != nil {
			slot.Instance = wrapperspb.String(*s.Instance)
		}
		out.Slots = append(out.Slots, slot)
	}
	return out
}
