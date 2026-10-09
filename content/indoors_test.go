package content

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"google.golang.org/protobuf/proto"
)

type loaderVector struct {
	Name  string `json:"name"`
	Valid bool   `json:"valid"`
	Edits []struct {
		Path  []any `json:"path"`
		Value any   `json:"value"`
	} `json:"edits"`
}

func readVectors(t *testing.T, name string, out any) {
	t.Helper()
	raw, err := os.ReadFile("vectors/" + name + ".json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, out); err != nil {
		t.Fatal(err)
	}
}
func editVector(t *testing.T, base json.RawMessage, v loaderVector) []byte {
	t.Helper()
	var doc any
	if err := json.Unmarshal(base, &doc); err != nil {
		t.Fatal(err)
	}
	for _, edit := range v.Edits {
		target := doc
		for _, key := range edit.Path[:len(edit.Path)-1] {
			switch k := key.(type) {
			case string:
				target = target.(map[string]any)[k]
			case float64:
				target = target.([]any)[int(k)]
			}
		}
		switch k := edit.Path[len(edit.Path)-1].(type) {
		case string:
			target.(map[string]any)[k] = edit.Value
		case float64:
			target.([]any)[int(k)] = edit.Value
		}
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
func TestIndoorsLoaderVectors(t *testing.T) {
	var roomVectors struct {
		Rooms, Residents []loaderVector
		Parents          []struct {
			Area, Parent, Root string
			Known              bool
		}
	}
	readVectors(t, "rooms", &roomVectors)
	roomBase, _ := FS.ReadFile("rooms.json")
	residentBase, _ := FS.ReadFile("residents.json")
	for _, v := range roomVectors.Rooms {
		t.Run("rooms/"+v.Name, func(t *testing.T) {
			_, err := DecodeRooms(editVector(t, roomBase, v))
			if (err == nil) != v.Valid {
				t.Fatal(v.Valid, err)
			}
		})
	}
	for _, v := range roomVectors.Residents {
		t.Run("residents/"+v.Name, func(t *testing.T) {
			_, err := DecodeResidents(editVector(t, residentBase, v))
			if (err == nil) != v.Valid {
				t.Fatal(v.Valid, err)
			}
		})
	}
	for _, v := range roomVectors.Parents {
		if RoomParent(v.Area) != v.Parent || RootArea(v.Area) != v.Root || KnownRoom(v.Area) != v.Known {
			t.Fatal(v)
		}
	}
	var questVectors struct {
		Base  json.RawMessage
		Cases []loaderVector
	}
	readVectors(t, "quests", &questVectors)
	for _, v := range questVectors.Cases {
		t.Run("quests/"+v.Name, func(t *testing.T) {
			_, err := DecodeQuests(editVector(t, questVectors.Base, v))
			if (err == nil) != v.Valid {
				t.Fatal(v.Valid, err)
			}
		})
	}
}
func TestResidentCycleVectors(t *testing.T) {
	var vectors struct {
		Cycles []struct {
			Resident     json.RawMessage
			Now          float64
			GraceSeconds int
			Expected     CyclePlace
			Near         []string
		}
	}
	readVectors(t, "clock", &vectors)
	if len(vectors.Cycles) == 0 {
		t.Fatal("no cycle vectors")
	}
	for _, v := range vectors.Cycles {
		var resident Resident
		if err := decodeContentProto(v.Resident, &resident); err != nil {
			t.Fatal(err)
		}
		if got := CycleAt(&resident, v.Now); got != v.Expected {
			t.Fatal(v, got)
		}
		if got := CycleSpotsNear(&resident, v.Now, v.GraceSeconds); !reflect.DeepEqual(got, v.Near) {
			t.Fatal(v, got)
		}
	}
	spotIs := func(got *ResidentSpot, area string, tx, ty int32) bool {
		return got != nil && got.GetArea() == area && got.GetTx() == tx && got.GetTy() == ty
	}
	if got, ok := ResidentAt("finn", 2700); !ok || !spotIs(got, "in:village:mill:2", 7, 5) {
		t.Fatal(got, ok)
	}
	for now, want := range map[float64][3]any{
		0:    {"commons", int32(26), int32(5)},
		600:  {"in:village:library", int32(9), int32(4)},
		2400: {"commons", int32(26), int32(5)},
	} {
		got, ok := ResidentAt("elara", now)
		if !ok || !spotIs(got, want[0].(string), want[1].(int32), want[2].(int32)) {
			t.Fatal(now, got, ok)
		}
	}
	if _, ok := ResidentAt("missing", 0); ok {
		t.Fatal("unknown resident")
	}
}

func TestRevisedLibraryVectors(t *testing.T) {
	var vectors struct {
		Room  json.RawMessage
		Seats []struct {
			Name  string
			Spot  *ResidentSpot
			Valid bool
		}
	}
	readVectors(t, "library", &vectors)
	var revised Room
	if err := decodeContentProto(vectors.Room, &revised); err != nil {
		t.Fatal(err)
	}
	doc, err := LoadRooms()
	if err != nil {
		t.Fatal(err)
	}
	for i, room := range doc.Rooms {
		if room.GetId() == revised.GetId() {
			doc.Rooms[i] = &revised
		}
	}
	if err := ValidateRooms(doc); err != nil {
		t.Fatal("revised library:", err)
	}
	// Shelves can seal a boundary only while they are solid.
	for i, room := range doc.Rooms {
		if room.GetId() == revised.GetId() {
			open := proto.Clone(&revised).(*Room)
			open.Props[0].Solid = proto.Bool(false)
			doc.Rooms[i] = open
		}
	}
	if err := ValidateRooms(doc); err == nil {
		t.Fatal("accepted non-solid boundary shelves")
	}
	for _, v := range vectors.Seats {
		t.Run(v.Name, func(t *testing.T) {
			if got := ResidentSpotFits(&revised, v.Spot); got != v.Valid {
				t.Fatal(got, v.Valid)
			}
		})
	}
}
func TestRoomFootprints(t *testing.T) {
	// Two separate piles of one letter stay two footprints (a fixture: the loft's
	// sacks are dressing since the round-2 art).
	piles := Room{Map: []string{"##########", "#.ff..ff.#", "#.ff..ff.#", "##########"}}
	want := []RoomFootprint{{"f", 2, 1, 2, 2}, {"f", 6, 1, 2, 2}}
	if got := RoomFootprints(&piles, "f"); !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
	if MarkWriter("library:lamp") != "server" || MarkWriter("quest-item:east-finger") != "server" {
		t.Fatal("quest reward namespaces")
	}
}

func TestQuestWaitVectors(t *testing.T) {
	var cases []struct {
		Name       string
		Wait       QuestWait
		Since, Now int64
		Ready      bool
	}
	readVectors(t, "quest-waits", &cases)
	for _, v := range cases {
		if QuestWaitReady(v.Wait, v.Since, v.Now) != v.Ready {
			t.Fatal(v)
		}
	}
}

func TestSellerLoaderVectors(t *testing.T) {
	var vectors []loaderVector
	readVectors(t, "sellers", &vectors)
	raw, err := FS.ReadFile("items.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		var items Items
		err = json.Unmarshal(editVector(t, raw, v), &items)
		if err == nil {
			err = ValidateItems(items)
		}
		if (err == nil) != v.Valid {
			t.Fatal(v.Name, err)
		}
	}
}
