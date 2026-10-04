package rules

import (
	"math"
	"testing"
	"time"
)

func TestLifetimeXPHugeLevelReturnsWithoutLooping(t *testing.T) {
	done := make(chan float64, 1)
	go func() { done <- LifetimeXP(1e12, 0) }()
	select {
	case n := <-done:
		if !math.IsNaN(n) {
			t.Fatal("unbounded level accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("huge level loops")
	}
}
