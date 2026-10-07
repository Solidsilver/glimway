package store

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"glimway/content"
	"math/big"
	"strings"
	"unicode"
)

const InviteWordCount = 6

// Six independent draws from 256 words plus 0000–9999 yield 61.287 bits.
// crypto/rand.Int uses rejection sampling, so every word/number is uniform.
func InviteCode() (string, error) {
	words := content.InviteWords
	parts := make([]string, 0, InviteWordCount+1)
	for range InviteWordCount {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(words))))
		if err != nil {
			return "", err
		}
		parts = append(parts, words[n.Int64()])
	}
	n, err := rand.Int(rand.Reader, big.NewInt(10000))
	if err != nil {
		return "", err
	}
	parts = append(parts, fmt.Sprintf("%04d", n.Int64()))
	return strings.Join(parts, "-"), nil
}

// Normalize only invitation input, never session tokens, IDs, or admin hashes.
// Legacy 64-hex codes retain their original canonical form and stored hash.
func NormalizeInvite(raw string) string {
	parts := strings.FieldsFunc(strings.ToLower(raw), func(r rune) bool { return r == '-' || unicode.IsSpace(r) })
	compact := strings.Join(parts, "")
	if len(compact) == 64 {
		if _, err := hex.DecodeString(compact); err == nil {
			return compact
		}
	}
	return strings.Join(parts, "-")
}
