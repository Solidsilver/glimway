package content

import (
	"fmt"
	"strings"

	contentv1 "glimway/gen/glimway/content/v1"
)

type (
	Story     = contentv1.Story
	Namespace = contentv1.Namespace
	Echo      = contentv1.Echo
)

// DecodeStory reads story JSON into the generated type, refusing nulls and
// unknown keys, then runs the schema's rules and the tables' own rules:
// one prefix per namespace (the schema's writer vocabulary and the
// npc/spot/quest-item shapes are on it).
func DecodeStory(raw []byte) (*Story, error) {
	doc := &Story{}
	if err := decodeContentProto(raw, "story", doc); err != nil {
		return doc, err
	}
	entries := make([]entryList, 1)
	entries[0] = entryList{field: "namespaces", ids: make([]string, len(doc.GetNamespaces()))}
	seen := map[string]bool{}
	for i, n := range doc.GetNamespaces() {
		entries[0].ids[i] = n.GetPrefix()
		if seen[entries[0].ids[i]] {
			return doc, fmt.Errorf("invalid story: duplicate namespace %s", entries[0].ids[i])
		}
		seen[entries[0].ids[i]] = true
	}
	return doc, contentValidate("story", entries, doc)
}

func LoadStory() (*Story, error) {
	raw, err := FS.ReadFile("story.json")
	if err != nil {
		return nil, err
	}
	return DecodeStory(raw)
}

var QuestRules = func() []*Quest {
	q, e := LoadQuests()
	if e != nil {
		panic(e)
	}
	return q.GetQuests()
}()
var StoryRules = func() *Story {
	s, e := LoadStory()
	if e != nil {
		panic(e)
	}
	return s
}()

// MarkWriter uses the longest matching namespace, including exact singleton marks.
func MarkWriter(mark string) string {
	best, writer := 0, ""
	for _, n := range StoryRules.GetNamespaces() {
		if (mark == n.GetPrefix() || strings.HasSuffix(n.GetPrefix(), ":") && strings.HasPrefix(mark, n.GetPrefix())) && len(n.GetPrefix()) > best {
			best, writer = len(n.GetPrefix()), n.GetWriter()
		}
	}
	return writer
}

// QuestFor returns a quest by id; array order never determines its identity.
func QuestFor(id string) (*Quest, bool) {
	for _, q := range QuestRules {
		if q.GetId() == id {
			return q, true
		}
	}
	return nil, false
}

// The one-argument form remains for the frozen 028 backfill's lantern road.
func QuestIndex(quest string, reached ...string) int {
	step := quest
	if len(reached) == 0 {
		quest = "lantern-road"
	} else {
		step = reached[0]
	}
	q, ok := QuestFor(quest)
	if !ok {
		return -2
	}
	if step == "" || step == "new" {
		return -1
	}
	for i, s := range q.GetSteps() {
		if s.GetId() == step {
			return i
		}
	}
	return -2
}
