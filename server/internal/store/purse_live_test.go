package store

import (
	"reflect"
	"testing"
)

// The live-reservation predicate is a required argument: a caller that
// leaves it out must not compile, or it would settle live work (review P3-3).
func TestSettleStaleTopUpsRequiresLive(t *testing.T) {
	fn := reflect.TypeOf(SettleStaleTopUps)
	if fn.IsVariadic() || fn.NumIn() != 5 || fn.In(4) != reflect.TypeOf(func(string) bool(nil)) {
		t.Fatalf("SettleStaleTopUps must take a required live predicate: %v", fn)
	}
}
