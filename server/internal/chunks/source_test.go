package chunks_test

import (
	"context"
	"database/sql"
	"errors"
	"glimway/server/internal/chunks"
	"glimway/server/internal/chunks/chunkstest"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/types/known/wrapperspb"
	"testing"
)

// validChunk is a small open-map chunk: a Tangle chunk on signed coordinates.
func validChunk() *contract.WorldChunk {
	return &contract.WorldChunk{EpochId: "epoch", Realm: "hearthwick", Look: "tangle", Cx: 1, Cy: -1, GeneratorVersion: 3, Size: 24, Tier: 1, Land: "woods", Palette: []string{"grass_b"}, Ground: make([]byte, 288), Solid: make([]byte, 72), Decor: &contract.DecorList{Kinds: []string{"oak"}, Kind: []uint32{0}, Tx: []uint32{2}, Ty: []uint32{3}, Ox: []int32{1}, Oy: []int32{-2}, Variant: []uint32{0}, Flags: []byte{0}}, Entities: []*contract.WildsEntity{{Id: "node:1:-1:0", Kind: "node", Tx: 3, Ty: 4, Material: "timber"}}}
}
func TestStoredGeometryAndExecutableFakes(t *testing.T) {
	ctx := context.Background()
	c := validChunk()
	if err := chunks.Validate(c); err != nil {
		t.Fatal(err)
	}
	c = validChunk()
	e, err := chunks.Entity(c, "node:1:-1:0")
	if err != nil || e.Material != "timber" {
		t.Fatal(e, err)
	}
	e.Material = "stone"
	if c.Entities[0].Material != "timber" {
		t.Fatal("entity read mutated geometry")
	}
	if len(chunks.DecorAt(c, 2, 3)) != 1 {
		t.Fatal("decor read")
	}
	c.Decor.Kind[0] = 9
	if chunks.Validate(c) == nil {
		t.Fatal("bad decor accepted")
	}
	key := chunkstest.Key{World: "world", Epoch: "epoch", Layer: 0, CX: 1, CY: -1}
	f := &chunkstest.Fake{Chunks: map[chunkstest.Key]*contract.WorldChunk{key: validChunk()}, Errors: map[chunkstest.Key]error{}}
	read, err := f.Chunk(ctx, nil, "world", "epoch", 0, 1, -1)
	if err != nil {
		t.Fatal(err)
	}
	read.Entities = nil
	read, err = f.Chunk(ctx, nil, "world", "epoch", 0, 1, -1)
	if err != nil || len(read.Entities) != 1 {
		t.Fatal("fake did not isolate reads")
	}
	if _, err = f.Chunk(ctx, nil, "other", "epoch", 0, 1, -1); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
	f.Errors[key] = chunks.ErrEpochEnded
	if _, err = f.Chunk(ctx, nil, "world", "epoch", 0, 1, -1); !errors.Is(err, chunks.ErrEpochEnded) {
		t.Fatal(err)
	}
	epochs := chunkstest.FakeEpochs{Values: map[chunkstest.EpochKey]*contract.WildsEpoch{{World: "world", Kind: "wick"}: {Id: "epoch"}}}
	if e, err := epochs.Create(ctx, nil, "world", "wick", 1); err != nil || e.Id != "epoch" {
		t.Fatal(e, err)
	}
	if _, err := epochs.Create(ctx, nil, "other", "wick", 1); !errors.Is(err, chunks.ErrUnavailable) {
		t.Fatal(err)
	}
}

func TestCurrentEpochIsReadOnlyAndDecorUsesTileRadius(t *testing.T) {
	ctx := context.Background()
	f := chunkstest.FakeEpochs{Values: map[chunkstest.EpochKey]*contract.WildsEpoch{{World: "world", Kind: "wick"}: {Id: "epoch", GeneratorVersion: 2, EndsAt: wrapperspb.Double(20)}}}
	f.CreateFunc = func(context.Context, *sql.Tx, string, string, int64) (*contract.WildsEpoch, error) {
		t.Fatal("Current created an epoch")
		return nil, nil
	}
	if _, err := f.Current(ctx, nil, "missing", "wick", 10); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal(err)
	}
	if _, err := f.Current(ctx, nil, "world", "wick", 20); !errors.Is(err, chunks.ErrEpochEnded) {
		t.Fatal(err)
	}
	v, err := f.Current(ctx, nil, "world", "wick", 10)
	if err != nil {
		t.Fatal(err)
	}
	v.Id = "changed"
	v, err = f.Current(ctx, nil, "world", "wick", 10)
	if err != nil || v.Id != "epoch" {
		t.Fatal("mutated stored epoch")
	}
	c := validChunk()
	if len(chunks.DecorWithin(c, 3.5, 3.5, 1)) != 1 || len(chunks.DecorWithin(c, 3.5, 3.5, 0.99)) != 0 {
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
		if chunks.Validate(c) == nil {
			t.Fatal("invalid chunk accepted", field)
		}
	}
}
