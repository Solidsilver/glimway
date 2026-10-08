package content

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
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
			var doc Rooms
			err := json.Unmarshal(editVector(t, roomBase, v), &doc)
			if err == nil {
				err = ValidateRooms(doc)
			}
			if (err == nil) != v.Valid {
				t.Fatal(v.Valid, err)
			}
		})
	}
	for _, v := range roomVectors.Residents {
		t.Run("residents/"+v.Name, func(t *testing.T) {
			var doc Residents
			err := json.Unmarshal(editVector(t, residentBase, v), &doc)
			if err == nil {
				err = ValidateResidents(doc)
			}
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
			Resident     Resident
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
		if got := CycleAt(v.Resident, v.Now); got != v.Expected {
			t.Fatal(v, got)
		}
		if got := CycleSpotsNear(v.Resident, v.Now, v.GraceSeconds); !reflect.DeepEqual(got, v.Near) {
			t.Fatal(v, got)
		}
	}
	if got, ok := ResidentAt("finn", 2700); !ok || got != (ResidentSpot{Area: "in:village:mill:2", TX: 7, TY: 5}) {
		t.Fatal(got, ok)
	}
	for now, want := range map[float64]ResidentSpot{
		0:    {Area: "commons", TX: 26, TY: 5},
		600:  {Area: "in:village:library", TX: 9, TY: 4, Seated: true},
		2400: {Area: "commons", TX: 26, TY: 5},
	} {
		if got, ok := ResidentAt("elara", now); !ok || got != want {
			t.Fatal(now, got, ok)
		}
	}
	if _, ok := ResidentAt("missing", 0); ok {
		t.Fatal("unknown resident")
	}
}

func TestRevisedLibraryVectors(t *testing.T) {
	var vectors struct {
		Room  Room
		Seats []struct {
			Name  string
			Spot  ResidentSpot
			Valid bool
		}
	}
	readVectors(t, "library", &vectors)
	doc, err := LoadRooms()
	if err != nil {
		t.Fatal(err)
	}
	for i, room := range doc.Rooms {
		if room.ID == vectors.Room.ID {
			doc.Rooms[i] = vectors.Room
		}
	}
	if err := ValidateRooms(doc); err != nil {
		t.Fatal("revised library:", err)
	}
	// Shelves can seal a boundary only while they are solid.
	for i, room := range doc.Rooms {
		if room.ID == vectors.Room.ID {
			doc.Rooms[i].Props = append([]RoomProp(nil), room.Props...)
			doc.Rooms[i].Props[0].Solid = false
		}
	}
	if err := ValidateRooms(doc); err == nil {
		t.Fatal("accepted non-solid boundary shelves")
	}
	for _, v := range vectors.Seats {
		t.Run(v.Name, func(t *testing.T) {
			if got := ResidentSpotFits(vectors.Room, v.Spot); got != v.Valid {
				t.Fatal(got, v.Valid)
			}
		})
	}
}
func TestRoomFootprints(t *testing.T) {
	loft, ok := RoomFor("in:village:mill:2")
	if !ok {
		t.Fatal("missing loft")
	}
	want := []RoomFootprint{{"f", 2, 2, 2, 2}, {"f", 6, 2, 2, 2}}
	if got := RoomFootprints(loft, "f"); !reflect.DeepEqual(got, want) {
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
