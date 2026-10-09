package content

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

var questID = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func validQuestID(id string) bool { return len(id) <= 100 && questID.MatchString(id) }

type QuestTrigger struct {
	Talk   string `json:"talk,omitempty"`
	Use    string `json:"use,omitempty"`
	Reach  string `json:"reach,omitempty"`
	Defeat string `json:"defeat,omitempty"`
	Carry  string `json:"carry,omitempty"`
	Flag   string `json:"flag,omitempty"`
	Open   string `json:"open,omitempty"`
	Sync   string `json:"sync,omitempty"`
	New    *bool  `json:"new,omitempty"`
}
type QuestWhere struct {
	Area  string `json:"area,omitempty"`
	NPC   string `json:"npc,omitempty"`
	Spot  string `json:"spot,omitempty"`
	Enemy string `json:"enemy,omitempty"`
	UI    string `json:"ui,omitempty"`
}
type QuestWait struct {
	Hours    float64 `json:"hours,omitempty"`
	Turnings int     `json:"turnings,omitempty"`
}
type QuestItem struct {
	Def string `json:"def"`
	Qty int    `json:"qty"`
}
type QuestGateItem struct {
	Def  string `json:"def"`
	Qty  int    `json:"qty"`
	Keep *bool  `json:"keep"`
}
type QuestGate struct {
	With   string         `json:"with,omitempty"`
	Wait   *QuestWait     `json:"wait,omitempty"`
	Item   *QuestGateItem `json:"item,omitempty"`
	Embers int            `json:"embers,omitempty"`
}
type QuestNote struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}
type QuestMoment struct {
	Eyebrow string `json:"eyebrow"`
	Title   string `json:"title"`
}
type QuestStep struct {
	ID        string        `json:"id"`
	At        string        `json:"at"`
	Items     []string      `json:"items"`
	Marks     []string      `json:"marks"`
	Papers    []string      `json:"papers"`
	Embers    int           `json:"embers"`
	Witness   string        `json:"witness"`
	Goal      string        `json:"goal,omitempty"`
	Objective string        `json:"objective,omitempty"`
	Where     *QuestWhere   `json:"where,omitempty"`
	Do        *QuestTrigger `json:"do"`
	Gate      *QuestGate    `json:"gate,omitempty"`
	Give      []QuestItem   `json:"give,omitempty"`
	Note      *QuestNote    `json:"note,omitempty"`
	Moment    *QuestMoment  `json:"moment,omitempty"`
}
type Quest struct {
	ID      string        `json:"id"`
	Title   string        `json:"title,omitempty"`
	Blurb   string        `json:"blurb,omitempty"`
	Line    string        `json:"line,omitempty"`
	Chapter *int          `json:"chapter,omitempty"`
	After   []string      `json:"after,omitempty"`
	Start   *QuestTrigger `json:"start,omitempty"`
	Needs   string        `json:"needs,omitempty"`
	Steps   []QuestStep   `json:"steps"`
}

func DecodeQuests(raw []byte) ([]Quest, error) {
	var doc struct {
		Quests []Quest `json:"quests"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&doc); err != nil {
		return nil, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, fmt.Errorf("invalid quests: trailing JSON")
	}
	if err := ValidateQuests(doc.Quests); err != nil {
		return nil, err
	}
	return doc.Quests, nil
}
func LoadQuests() ([]Quest, error) {
	raw, err := FS.ReadFile("quests.json")
	if err != nil {
		return nil, err
	}
	return DecodeQuests(raw)
}
func QuestSpotArea(id string) string {
	for _, r := range RoomRules.Rooms {
		if _, ok := r.GetSpots()[id]; ok {
			return r.GetId()
		}
	}
	return StoryRules.Spots[id]
}
func ValidateQuests(quests []Quest) error {
	bad := func(s string) error { return fmt.Errorf("invalid quests: %s", s) }
	if len(quests) == 0 {
		return bad("empty")
	}
	items, err := LoadItems()
	if err != nil {
		return err
	}
	defs := map[string]bool{}
	for _, d := range items.Items {
		defs[d.ID] = true
	}
	papers, err := LoadPapers()
	if err != nil {
		return err
	}
	paperIDs := map[string]bool{}
	for _, p := range papers {
		paperIDs[p.ID] = true
	}
	story, err := LoadStory()
	if err != nil {
		return err
	}
	spots := map[string]string{}
	for id, area := range story.Spots {
		spots[id] = area
	}
	for _, r := range RoomRules.Rooms {
		for id := range r.GetSpots() {
			spots[id] = r.GetId()
		}
	}
	npc := func(id string) bool { _, resident := ResidentByID(id); return resident || story.NPCs[id] != "" }
	writer := func(mark string) bool {
		for _, n := range story.Namespaces {
			if mark == n.Prefix || strings.HasSuffix(n.Prefix, ":") && strings.HasPrefix(mark, n.Prefix) {
				return true
			}
		}
		return false
	}
	byID := map[string]Quest{}
	questItems := map[string]bool{}
	for _, id := range story.QuestItems {
		questItems[id] = true
	}
	for _, q := range quests {
		if !validQuestID(q.ID) || byID[q.ID].ID != "" || len(q.Steps) == 0 || q.Line != "" && !slices.Contains([]string{"road", "village", "craft"}, q.Line) || q.Chapter != nil && (*q.Chapter < 0 || *q.Chapter > 9007199254740991 || q.Line != "road") || q.Needs != "" && q.Needs != "habitica" {
			return bad("quest " + q.ID)
		}
		byID[q.ID] = q
		for _, s := range q.Steps {
			for _, id := range s.Items {
				if !questItems[id] {
					return bad("unknown quest item " + id)
				}
			}
		}
	}
	trigger := func(t *QuestTrigger, start bool) error {
		if t == nil {
			return bad("missing trigger")
		}
		count := 0
		for _, v := range []string{t.Talk, t.Use, t.Reach, t.Defeat, t.Carry, t.Flag, t.Open, t.Sync} {
			if v != "" {
				count++
			}
		}
		if t.New != nil {
			count++
			if !start || !*t.New {
				return bad("new trigger")
			}
		}
		if count != 1 {
			return bad("one trigger required")
		}
		if t.Talk != "" && !npc(t.Talk) || t.Use != "" && spots[t.Use] == "" || t.Reach != "" && !KnownContentArea(t.Reach) || t.Defeat != "" && story.IDs["defeated:"][t.Defeat] == "" || t.Carry != "" && !defs[t.Carry] && !questItems[t.Carry] || t.Flag != "" && !writer(t.Flag) || t.Open != "" && t.Open != "journal" || t.Sync != "" && t.Sync != "embers" {
			return bad("unknown trigger target")
		}
		return nil
	}
	for _, q := range quests {
		if q.Start != nil {
			if err := trigger(q.Start, true); err != nil {
				return err
			}
		}
		seen := map[string]bool{}
		for i, s := range q.Steps {
			if !validQuestID(s.ID) || seen[s.ID] || s.Embers < 0 || s.Embers > 5 || utf8.RuneCountInString(s.Goal) > 40 || s.At != "" && !KnownContentArea(s.At) || s.Items == nil || s.Marks == nil || s.Papers == nil || s.Witness != "" && !slices.Contains([]string{"warden", "lantern"}, s.Witness) {
				return bad("step " + q.ID + ":" + s.ID)
			}
			seen[s.ID] = true
			if err := trigger(s.Do, false); err != nil {
				return err
			}
			for _, mark := range s.Marks {
				if !writer(mark) {
					return bad("unknown mark " + mark)
				}
			}
			for _, id := range s.Papers {
				if !paperIDs[id] {
					return bad("unknown paper " + id)
				}
			}
			g := s.Gate
			if g != nil {
				if g.With == "" && g.Wait == nil && g.Item == nil && g.Embers == 0 || g.With != "" && !npc(g.With) || g.Embers < 0 || g.Embers > 9007199254740991 {
					return bad("gate " + s.ID)
				}
				if w := g.Wait; w != nil {
					if i == 0 || math.IsNaN(w.Hours) || math.IsInf(w.Hours, 0) || w.Hours < 0 || w.Turnings < 0 || w.Turnings > 9007199254740991 || (w.Hours > 0) == (w.Turnings > 0) {
						return bad("wait " + s.ID)
					}
				}
				if item := g.Item; item != nil {
					if !defs[item.Def] || item.Qty < 1 || item.Qty > 9007199254740991 || item.Keep == nil {
						return bad("gate item " + s.ID)
					}
				}
			}
			if len(s.Give) > 0 && g == nil {
				return bad("ungated give " + s.ID)
			}
			give := map[string]bool{}
			for _, item := range s.Give {
				if !defs[item.Def] || item.Qty < 1 || item.Qty > 9007199254740991 || give[item.Def] {
					return bad("give " + s.ID)
				}
				give[item.Def] = true
			}
			if s.Note != nil && (s.Note.Title == "" || s.Note.Body == "") || s.Moment != nil && (s.Moment.Title == "" || s.Moment.Eyebrow == "") {
				return bad("note/moment " + s.ID)
			}
			t := s.Do
			anywhere := t.Carry != "" || t.Open != "" || t.Sync != "" || t.Flag != ""
			if s.At == "" && !anywhere && (g == nil || g.With == "") {
				return bad("empty at " + s.ID)
			}
			if t.Talk != "" {
				if _, moving := ResidentByID(t.Talk); moving {
					if s.At != "" || g == nil || g.With != t.Talk {
						return bad("resident talk " + s.ID)
					}
				} else if s.At != story.NPCs[t.Talk] {
					return bad("npc area " + s.ID)
				}
			}
			if t.Use != "" && s.At != spots[t.Use] || t.Reach != "" && s.At != t.Reach || t.Defeat != "" && s.At != story.IDs["defeated:"][t.Defeat] {
				return bad("trigger area " + s.ID)
			}
			if w := s.Where; w != nil {
				count := 0
				for _, v := range []string{w.NPC, w.Spot, w.Enemy, w.UI} {
					if v != "" {
						count++
					}
				}
				if count > 1 || count == 0 && w.Area == "" || w.Area != "" && !KnownContentArea(w.Area) || w.UI != "" && (w.UI != "journal" || w.Area != "") {
					return bad("where " + s.ID)
				}
				if w.NPC != "" {
					if !npc(w.NPC) {
						return bad("where npc " + s.ID)
					}
					if _, moving := ResidentByID(w.NPC); !moving && w.Area != "" && w.Area != story.NPCs[w.NPC] {
						return bad("where npc area " + s.ID)
					}
				}
				if w.Spot != "" && (spots[w.Spot] == "" || w.Area != "" && w.Area != spots[w.Spot]) || w.Enemy != "" && (story.IDs["defeated:"][w.Enemy] == "" || w.Area != "" && w.Area != story.IDs["defeated:"][w.Enemy]) {
					return bad("where target " + s.ID)
				}
			}
		}
		refs := map[string]bool{}
		for _, ref := range q.After {
			parts := strings.Split(ref, ":")
			target, ok := byID[parts[0]]
			if !ok || len(parts) > 2 || refs[ref] || len(parts) == 2 && !slices.ContainsFunc(target.Steps, func(s QuestStep) bool { return s.ID == parts[1] }) {
				return bad("after " + ref)
			}
			refs[ref] = true
		}
	}
	visiting, done := map[string]bool{}, map[string]bool{}
	var visit func(string) bool
	visit = func(id string) bool {
		if visiting[id] {
			return false
		}
		if done[id] {
			return true
		}
		visiting[id] = true
		for _, ref := range byID[id].After {
			if !visit(strings.Split(ref, ":")[0]) {
				return false
			}
		}
		delete(visiting, id)
		done[id] = true
		return true
	}
	for id := range byID {
		if !visit(id) {
			return bad("after cycle")
		}
	}
	return nil
}
