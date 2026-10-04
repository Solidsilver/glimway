package content

import (
	"encoding/json"
	"fmt"
)

func ValidateInviteWords(words []string) error {
	if len(words) != 256 {
		return fmt.Errorf("invite wordlist must contain 256 words")
	}
	seen := map[string]bool{}
	for _, word := range words {
		if len(word) < 3 || len(word) > 12 || seen[word] {
			return fmt.Errorf("invalid invite word")
		}
		for _, r := range word {
			if r < 'a' || r > 'z' {
				return fmt.Errorf("invite words must be lowercase ASCII letters")
			}
		}
		seen[word] = true
	}
	return nil
}
func LoadInviteWords() ([]string, error) {
	var words []string
	b, err := FS.ReadFile("invite-words.json")
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(b, &words); err != nil {
		return nil, err
	}
	return words, ValidateInviteWords(words)
}

var InviteWords = func() []string {
	words, err := LoadInviteWords()
	if err != nil {
		panic(err)
	}
	return words
}()
