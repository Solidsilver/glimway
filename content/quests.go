package content

import (
	"fmt"
	"slices"
	"strings"

	contentv1 "glimway/gen/glimway/content/v1"
)

type (
	Quests        = contentv1.Quests
	Quest         = contentv1.Quest
	QuestStep     = contentv1.QuestStep
	QuestTrigger  = contentv1.QuestTrigger
	QuestWhere    = contentv1.QuestWhere
	QuestWait     = contentv1.QuestWait
	QuestItem     = contentv1.QuestItem
	QuestGate     = contentv1.QuestGate
	QuestGateItem = contentv1.QuestGateItem
	QuestNote     = contentv1.QuestNote
	QuestMoment   = contentv1.QuestMoment
)

// DecodeQuests reads quests JSON into the generated types, refusing nulls
// and unknown keys, then runs the schema's rules (the per-step shape: one
// trigger, wait, gate, give, note and moment) and the tree's own rules in
// code: quest-id uniqueness and every reference into the other tables
// (npcs, spots, areas, papers, items), with the after-graph acyclic.
func DecodeQuests(raw []byte) (*Quests, error) {
	doc := &Quests{}
	if err := decodeContentProto(raw, "quests", doc); err != nil {
		return doc, err
	}
	if err := contentValidate("quests", entryLists(doc, "quests"), doc); err != nil {
		return doc, err
	}
	if err := validateQuests(doc); err != nil {
		return doc, err
	}
	return doc, nil
}

func LoadQuests() (*Quests, error) {
	raw, err := FS.ReadFile("quests.json")
	if err != nil {
		return nil, err
	}
	return DecodeQuests(raw)
}

// triggerHasNew: `new` is an optional bool, so a plain Get reads an
// explicit false as unset; the trigger rule needs the presence.
func triggerHasNew(t *QuestTrigger) bool {
	fd := t.ProtoReflect().Descriptor().Fields().ByName("new")
	return t.ProtoReflect().Has(fd)
}

func QuestSpotArea(id string) string {
	for _, r := range RoomRules.GetRooms() {
		if _, ok := r.GetSpots()[id]; ok {
			return r.GetId()
		}
	}
	return StoryRules.GetSpots()[id]
}

// validateQuests runs the rules that reach across entries: quest-id
// uniqueness and every reference into the story tables, papers, items and
// rooms. Field rules live on the schema (proto/glimway/content/v1/
// quests.proto); it assumes the schema has passed, so it is only called
// after protovalidate.
func validateQuests(doc *Quests) error {
	bad := func(s string) error { return fmt.Errorf("invalid quests: %s", s) }
	quests := doc.GetQuests()
	items, err := LoadItems()
	if err != nil {
		return err
	}
	defs := map[string]bool{}
	for _, d := range items.Items {
		defs[d.GetId()] = true
	}
	papers, err := LoadPapers()
	if err != nil {
		return err
	}
	paperIDs := map[string]bool{}
	for _, p := range papers {
		paperIDs[p.GetId()] = true
	}
	story, err := LoadStory()
	if err != nil {
		return err
	}
	spots := map[string]string{}
	for id, area := range story.GetSpots() {
		spots[id] = area
	}
	for _, r := range RoomRules.GetRooms() {
		for id := range r.GetSpots() {
			spots[id] = r.GetId()
		}
	}
	npc := func(id string) bool { _, resident := ResidentByID(id); return resident || story.GetNpcs()[id] != "" }
	writer := func(mark string) bool {
		for _, n := range story.GetNamespaces() {
			if mark == n.GetPrefix() || strings.HasSuffix(n.GetPrefix(), ":") && strings.HasPrefix(mark, n.GetPrefix()) {
				return true
			}
		}
		return false
	}
	byID := map[string]*Quest{}
	questItems := map[string]bool{}
	for _, id := range story.GetQuestItems() {
		questItems[id] = true
	}
	for _, q := range quests {
		if byID[q.GetId()] != nil {
			return bad("duplicate id " + q.GetId())
		}
		byID[q.GetId()] = q
		for _, s := range q.GetSteps() {
			for _, id := range s.GetItems() {
				if !questItems[id] {
					return bad("unknown quest item " + id)
				}
			}
		}
	}
	// A step's trigger names a target in the tables; `new` is only ever a
	// quest's start, and only true.
	trigger := func(t *QuestTrigger, start bool) error {
		if t == nil {
			return bad("missing trigger")
		}
		if triggerHasNew(t) && (!start || !t.GetNew()) {
			return bad("new trigger")
		}
		if t.GetTalk() != "" && !npc(t.GetTalk()) || t.GetUse() != "" && spots[t.GetUse()] == "" || t.GetReach() != "" && !KnownContentArea(t.GetReach()) || t.GetDefeat() != "" && story.GetIds()["defeated:"].GetAreas()[t.GetDefeat()] == "" || t.GetCarry() != "" && !defs[t.GetCarry()] && !questItems[t.GetCarry()] || t.GetFlag() != "" && !writer(t.GetFlag()) || t.GetOpen() != "" && t.GetOpen() != "journal" || t.GetSync() != "" && t.GetSync() != "glims" {
			return bad("unknown trigger target")
		}
		return nil
	}
	for _, q := range quests {
		if q.GetStart() != nil {
			if err := trigger(q.GetStart(), true); err != nil {
				return err
			}
		}
		for i, s := range q.GetSteps() {
			if s.GetAt() != "" && !KnownContentArea(s.GetAt()) {
				return bad("step " + q.GetId() + ":" + s.GetId())
			}
			for _, mark := range s.GetMarks() {
				if !writer(mark) {
					return bad("unknown mark " + mark)
				}
			}
			for _, id := range s.GetPapers() {
				if !paperIDs[id] {
					return bad("unknown paper " + id)
				}
			}
			g := s.GetGate()
			if g != nil {
				if g.GetWith() != "" && !npc(g.GetWith()) {
					return bad("gate " + s.GetId())
				}
				if w := g.GetWait(); w != nil && i == 0 {
					return bad("wait " + s.GetId())
				}
				if item := g.GetItem(); item != nil && !defs[item.GetDef()] {
					return bad("gate item " + s.GetId())
				}
			}
			for _, item := range s.GetGive() {
				if !defs[item.GetDef()] {
					return bad("give " + s.GetId())
				}
			}
			if err := trigger(s.GetDo(), false); err != nil {
				return err
			}
			t := s.GetDo()
			if t.GetTalk() != "" {
				if _, moving := ResidentByID(t.GetTalk()); moving {
					if s.GetAt() != "" || g == nil || g.GetWith() != t.GetTalk() {
						return bad("resident talk " + s.GetId())
					}
				} else if s.GetAt() != story.GetNpcs()[t.GetTalk()] {
					return bad("npc area " + s.GetId())
				}
			}
			if t.GetUse() != "" && s.GetAt() != spots[t.GetUse()] || t.GetReach() != "" && s.GetAt() != t.GetReach() || t.GetDefeat() != "" && s.GetAt() != story.GetIds()["defeated:"].GetAreas()[t.GetDefeat()] {
				return bad("trigger area " + s.GetId())
			}
			if w := s.GetWhere(); w != nil {
				if w.GetArea() != "" && !KnownContentArea(w.GetArea()) {
					return bad("where " + s.GetId())
				}
				if w.GetNpc() != "" {
					if !npc(w.GetNpc()) {
						return bad("where npc " + s.GetId())
					}
					if _, moving := ResidentByID(w.GetNpc()); !moving && w.GetArea() != "" && w.GetArea() != story.GetNpcs()[w.GetNpc()] {
						return bad("where npc area " + s.GetId())
					}
				}
				if w.GetSpot() != "" && (spots[w.GetSpot()] == "" || w.GetArea() != "" && w.GetArea() != spots[w.GetSpot()]) || w.GetEnemy() != "" && (story.GetIds()["defeated:"].GetAreas()[w.GetEnemy()] == "" || w.GetArea() != "" && w.GetArea() != story.GetIds()["defeated:"].GetAreas()[w.GetEnemy()]) {
					return bad("where target " + s.GetId())
				}
			}
		}
		refs := map[string]bool{}
		for _, ref := range q.GetAfter() {
			parts := strings.Split(ref, ":")
			target, ok := byID[parts[0]]
			if !ok || len(parts) > 2 || refs[ref] || len(parts) == 2 && !slices.ContainsFunc(target.GetSteps(), func(s *QuestStep) bool { return s.GetId() == parts[1] }) {
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
		for _, ref := range byID[id].GetAfter() {
			if !visit(strings.Split(ref, ":")[0]) {
				return false
			}
		}
		delete(visiting, id)
		done[id] = true
		return true
	}
	for _, q := range quests {
		if !visit(q.GetId()) {
			return bad("after cycle")
		}
	}
	return nil
}
