package chunks

import (
	"context"
	"database/sql"
	"errors"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/types/known/wrapperspb"
	"testing"
)

func validChunk() *contract.WildsChunk {
	return &contract.WildsChunk{EpochId: "epoch", Region: "inner-1", Realm: "hearthwick", Look: "tangle", Cx: 1, Cy: 0, GeneratorVersion: 2, Size: 24, Palette: []string{"grass"}, Ground: make([]byte, 288), Solid: make([]byte, 72), Spawn: &contract.Tile{Tx: 1, Ty: 1}, Decor: &contract.DecorList{Kinds: []string{"tree"}, Kind: []uint32{0}, Tx: []uint32{2}, Ty: []uint32{3}, Ox: []int32{1}, Oy: []int32{-2}, Variant: []uint32{0}, Flags: []byte{0}}, Entities: []*contract.WildsEntity{{Id: "node:1:0:0", Kind: "node", Tx: 3, Ty: 4, Material: "timber"}}, Exits: []*contract.Exit{{Tx: 12, Ty: 0, Tw: 1, Th: 1, Dir: contract.Dir_DIR_NORTH, To: "chunk:outer-1:1:2", Entry: &contract.Tile{Tx: 12, Ty: 23}}}}
}
func TestStoredGeometryAndExecutableFakes(t *testing.T) {
	ctx := context.Background()
	c := validChunk()
	if err := Validate(c); err != nil {
		t.Fatal(err)
	}
	c.Exits[0].To = "commons"
	c.Exits[0].Entry = &contract.Tile{Tx: 23, Ty: 2}
	if err := Validate(c); err != nil {
		t.Fatal(err)
	}
	c.Exits[0].Entry.Tx = 62
	if Validate(c) == nil {
		t.Fatal("invalid destination accepted")
	}
	c = validChunk()
	e, err := Entity(c, "node:1:0:0")
	if err != nil || e.Material != "timber" {
		t.Fatal(e, err)
	}
	e.Material = "stone"
	if c.Entities[0].Material != "timber" {
		t.Fatal("entity read mutated geometry")
	}
	if len(DecorAt(c, 2, 3)) != 1 {
		t.Fatal("decor read")
	}
	c.Decor.Kind[0] = 9
	if Validate(c) == nil {
		t.Fatal("bad decor accepted")
	}
	key := Key{"world", "epoch", 0, 1, 0}
	f := &Fake{Chunks: map[Key]*contract.WildsChunk{key: validChunk()}, Errors: map[Key]error{}}
	read, err := f.Chunk(ctx, nil, "world", "epoch", 0, 1, 0)
	if err != nil {
		t.Fatal(err)
	}
	read.Entities = nil
	read, err = f.Chunk(ctx, nil, "world", "epoch", 0, 1, 0)
	if err != nil || len(read.Entities) != 1 {
		t.Fatal("fake did not isolate reads")
	}
	if _, err = f.Chunk(ctx, nil, "other", "epoch", 0, 1, 0); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
	f.Errors[key] = ErrEpochEnded
	if _, err = f.Chunk(ctx, nil, "world", "epoch", 0, 1, 0); !errors.Is(err, ErrEpochEnded) {
		t.Fatal(err)
	}
	epochs := FakeEpochs{Values: map[EpochKey]*contract.WildsEpoch{{"world", "outer-1"}: {Id: "epoch"}}}
	if e, err := epochs.Create(ctx, nil, "world", "outer-1", 1); err != nil || e.Id != "epoch" {
		t.Fatal(e, err)
	}
	if _, err := epochs.Create(ctx, nil, "other", "outer-1", 1); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
}

func TestCurrentEpochIsReadOnlyAndDecorUsesTileRadius(t *testing.T) {
	ctx := context.Background()
	f := FakeEpochs{Values: map[EpochKey]*contract.WildsEpoch{{"world", "outer-1"}: {Id: "epoch", GeneratorVersion: 2, EndsAt: wrapperspb.Double(20)}}}
	f.CreateFunc = func(context.Context, *sql.Tx, string, string, int64) (*contract.WildsEpoch, error) {
		t.Fatal("Current created an epoch")
		return nil, nil
	}
	if _, err := f.Current(ctx, nil, "missing", "outer-1", 10); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
	if _, err := f.Current(ctx, nil, "world", "outer-1", 20); !errors.Is(err, ErrEpochEnded) {
		t.Fatal(err)
	}
	v, err := f.Current(ctx, nil, "world", "outer-1", 10)
	if err != nil {
		t.Fatal(err)
	}
	v.Id = "changed"
	v, err = f.Current(ctx, nil, "world", "outer-1", 10)
	if err != nil || v.Id != "epoch" {
		t.Fatal("mutated stored epoch")
	}
	c := validChunk()
	if len(DecorWithin(c, 3.5, 3.5, 1)) != 1 || len(DecorWithin(c, 3.5, 3.5, 0.99)) != 0 {
		t.Fatal("decor reach must use tile centres")
	}
	for _, field := range []string{"realm", "look", "layer", "node"} {
		c := validChunk()
		switch field {
		case "realm":
			c.Realm = "unknown"
		case "look":
			c.Look = "unknown"
		case "layer":
			c.Layer = -1
		case "node":
			c.Entities[0].Material = ""
		}
		if Validate(c) == nil {
			t.Fatal("invalid chunk accepted", field)
		}
	}
}
