package api

import (
	"fmt"
	"strings"
	"unicode"
)

// giftPhrase is the server port of src/lib/items.ts giftPhrase. Keep a maker's
// name and authored articles intact while making common item names readable.
func giftPhrase(name string, qty int) string {
	original := name
	article := ""
	for _, a := range []string{"a ", "an ", "the "} {
		if strings.HasPrefix(strings.ToLower(name), a) {
			article = a
			name = name[len(a):]
			break
		}
	}
	proper := strings.Contains(name, "'s") || strings.Contains(name, "’s")
	if article != "" {
		if strings.TrimSpace(article) != "the" {
			name = strings.ToLower(name)
		}
		if qty == 1 {
			return article + name
		}
		return fmt.Sprintf("%d %s", qty, name)
	}
	shown := name
	if !proper && shown != "" {
		shown = strings.ToLower(shown)
	}
	if qty != 1 {
		if !strings.HasSuffix(original, "s") {
			original += "s"
		}
		return fmt.Sprintf("%d %s", qty, original)
	}
	if proper {
		return shown
	}
	article = "a"
	if len(shown) > 0 && strings.ContainsRune("aeiou", unicode.ToLower([]rune(shown)[0])) {
		article = "an"
	}
	return article + " " + shown
}
