package content

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

type QuestStep struct {
	ID      string   `json:"id"`
	At      string   `json:"at"`
	Items   []string `json:"items"`
	Marks   []string `json:"marks"`
	Papers  []string `json:"papers"`
	Embers  int      `json:"embers"`
	Witness string   `json:"witness"`
}
type Quest struct {
	ID    string      `json:"id"`
	Steps []QuestStep `json:"steps"`
}
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
func LoadQuests() ([]Quest, error) {
	var doc struct {
		Quests []Quest `json:"quests"`
	}
	if e := readTable("quests.json", &doc); e != nil {
		return nil, e
	}
	seen := map[string]bool{}
	for _, q := range doc.Quests {
		if q.ID == "" || seen[q.ID] || len(q.Steps) == 0 {
			return nil, fmt.Errorf("invalid quest %s", q.ID)
		}
		seen[q.ID] = true
		ids := map[string]bool{}
		for _, s := range q.Steps {
			if s.ID == "" || ids[s.ID] || !slices.Contains([]string{"village", "woodland", "ruin", "commons"}, s.At) || s.Embers < 0 {
				return nil, fmt.Errorf("invalid quest step %s", s.ID)
			}
			ids[s.ID] = true
		}
	}
	if len(doc.Quests) == 0 {
		return nil, fmt.Errorf("empty quests")
	}
	return doc.Quests, nil
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
