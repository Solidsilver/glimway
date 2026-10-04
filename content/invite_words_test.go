package content

import (
	"math"
	"testing"
)

func TestInviteWordlistAndEntropy(t *testing.T) {
	words, err := LoadInviteWords()
	if err != nil {
		t.Fatal(err)
	}
	if bits := 6*math.Log2(float64(len(words))) + math.Log2(10000); bits < 60 {
		t.Fatal("insufficient invite entropy", bits)
	}
	for name, mutate := range map[string]func([]string) []string{
		"length": func(w []string) []string { return w[:255] }, "duplicate": func(w []string) []string { w[1] = w[0]; return w }, "uppercase": func(w []string) []string { w[0] = "Amber"; return w }, "separator": func(w []string) []string { w[0] = "amber-fox"; return w }, "digit": func(w []string) []string { w[0] = "fox1"; return w }, "short": func(w []string) []string { w[0] = "a"; return w }, "long": func(w []string) []string { w[0] = "abcdefghijklmn"; return w },
	} {
		t.Run(name, func(t *testing.T) {
			copy := append([]string{}, words...)
			if ValidateInviteWords(mutate(copy)) == nil {
				t.Fatal("accepted malformed catalog")
			}
		})
	}
}
