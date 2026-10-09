package content

import (
	"fmt"

	contentv1 "glimway/gen/glimway/content/v1"
)

type (
	Papers    = contentv1.Papers
	Paper     = contentv1.Paper
	PaperRule = contentv1.PaperRule
)

// DecodePapers reads papers JSON into the generated types, refusing nulls
// and unknown keys, then runs the schema's rules (the sources and shelf
// signs, each find rule's own fields) and the catalog's own rule: one id
// per paper, naming the duplicate.
func DecodePapers(raw []byte) ([]*Paper, error) {
	doc := &Papers{}
	if err := decodeContentProto(raw, "papers", doc); err != nil {
		return nil, err
	}
	if err := contentValidate("papers", entryLists(doc, "papers"), doc); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, p := range doc.GetPapers() {
		if seen[p.GetId()] {
			return nil, fmt.Errorf("invalid papers: duplicate id %s", p.GetId())
		}
		seen[p.GetId()] = true
	}
	return doc.GetPapers(), nil
}

func LoadPapers() ([]*Paper, error) {
	raw, err := FS.ReadFile("papers.json")
	if err != nil {
		return nil, err
	}
	return DecodePapers(raw)
}

// PapersByID: the shared paper catalog by id (the find is the story flag
// `paper:<id>`).
var PapersByID = func() map[string]*Paper {
	ps, err := LoadPapers()
	if err != nil {
		panic(err)
	}
	m := make(map[string]*Paper, len(ps))
	for _, p := range ps {
		m[p.GetId()] = p
	}
	return m
}()
