package content

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

type Namespace struct {
	Prefix string `json:"prefix"`
	Writer string `json:"writer"`
}
type Echo struct {
	Member string `json:"member"`
	Late   bool   `json:"late"`
	East   bool   `json:"east"`
}
type Story struct {
	QuestItems []string                     `json:"questItems"`
	NPCs       map[string]string            `json:"npcs"`
	Spots      map[string]string            `json:"spots"`
	Namespaces []Namespace                  `json:"namespaces"`
	IDs        map[string]map[string]string `json:"ids"`
	Areas      map[string]string            `json:"areas"`
	Boards     map[string]struct {
		TX int `json:"tx"`
		TY int `json:"ty"`
	} `json:"boards"`
	Echoes []Echo `json:"echoes"`
}

func readTable(name string, out any) error {
	b, e := FS.ReadFile(name)
	if e != nil {
		return e
	}
	return json.Unmarshal(b, out)
}
func LoadStory() (Story, error) {
	var s Story
	if e := readTable("story.json", &s); e != nil {
		return s, e
	}
	seen := map[string]bool{}
	for _, n := range s.Namespaces {
		if n.Prefix == "" || seen[n.Prefix] || (n.Writer != "client" && n.Writer != "server") {
			return s, fmt.Errorf("invalid namespace %s", n.Prefix)
		}
		seen[n.Prefix] = true
	}
	if len(seen) == 0 || len(s.Echoes) != 6 {
		return s, fmt.Errorf("invalid story")
	}
	for _, table := range []map[string]string{s.NPCs, s.Spots} {
		if len(table) == 0 {
			return s, fmt.Errorf("empty story targets")
		}
		for id, area := range table {
			if !ValidContentID(id) || !slices.Contains([]string{"village", "woodland", "ruin", "commons"}, area) {
				return s, fmt.Errorf("invalid story target %s", id)
			}
		}
	}
	items := map[string]bool{}
	for _, id := range s.QuestItems {
		if !ValidContentID(id) || items[id] {
			return s, fmt.Errorf("invalid story quest item %s", id)
		}
		items[id] = true
	}
	if len(items) == 0 {
		return s, fmt.Errorf("empty story quest items")
	}
	return s, nil
}

var QuestRules = func() []Quest {
	q, e := LoadQuests()
	if e != nil {
		panic(e)
	}
	return q
}()
var StoryRules = func() Story {
	s, e := LoadStory()
	if e != nil {
		panic(e)
	}
	return s
}()

// MarkWriter uses the longest matching namespace, including exact singleton marks.
func MarkWriter(mark string) string {
	best, writer := 0, ""
	for _, n := range StoryRules.Namespaces {
		if (mark == n.Prefix || strings.HasSuffix(n.Prefix, ":") && strings.HasPrefix(mark, n.Prefix)) && len(n.Prefix) > best {
			best, writer = len(n.Prefix), n.Writer
		}
	}
	return writer
}
func QuestIndex(step string) int {
	if step == "new" {
		return -1
	}
	for i, s := range QuestRules[0].Steps {
		if s.ID == step {
			return i
		}
	}
	return -2
}
