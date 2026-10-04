package store

import (
	"fingersnap/content"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestReadableInviteGenerationAndNormalization(t *testing.T) {
	seen := map[string]bool{}
	for range 128 {
		code, err := InviteCode()
		if err != nil {
			t.Fatal(err)
		}
		if seen[code] {
			t.Fatal("duplicate random invite")
		}
		seen[code] = true
		parts := strings.Split(code, "-")
		if len(parts) != InviteWordCount+1 || len(code) > 128 {
			t.Fatal("code format", code)
		}
		for _, word := range parts[:InviteWordCount] {
			if !slices.Contains(content.InviteWords, word) {
				t.Fatal("unknown word")
			}
		}
		if n, err := strconv.Atoi(parts[InviteWordCount]); err != nil || n < 0 || n > 9999 || len(parts[InviteWordCount]) != 4 {
			t.Fatal("digit suffix")
		}
		for _, input := range []string{code, "  " + strings.ToUpper(code) + " ", strings.ReplaceAll(code, "-", " "), strings.ReplaceAll(code, "-", " - \t - "), strings.ReplaceAll(code, "-", "\u2003")} {
			if NormalizeInvite(input) != code {
				t.Fatal("normalization", input)
			}
		}
	}
	legacy := strings.Repeat("a1", 32)
	for _, input := range []string{legacy, strings.ToUpper(legacy), legacy[:32] + "-" + legacy[32:], " " + legacy[:16] + " " + legacy[16:] + " "} {
		if NormalizeInvite(input) != legacy || Hash(NormalizeInvite(input)) != Hash(legacy) {
			t.Fatal("legacy lookup changed")
		}
	}
	if NormalizeInvite("\t--- \n") != "" {
		t.Fatal("empty normalized invite")
	}
}
