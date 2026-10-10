// Package content holds the canonical shared data, read directly by Go and Vite.
package content

import (
	"embed"

	contentv1 "glimway/gen/glimway/content/v1"
)

//go:embed *.json
var FS embed.FS

// The shared economy contract (content/economy.json): glim pricing, sync
// credit, invites and the Wilds' rate limits. The schema and its rules live
// in proto/glimway/content/v1/economy.proto; there are no rules left in code.
type Economy = contentv1.Economy

// DecodeEconomy reads economy JSON into the generated types, refusing nulls
// and unknown keys, then runs the schema's rules (protovalidate).
func DecodeEconomy(raw []byte) (*Economy, error) {
	doc := &Economy{}
	if err := decodeContentProto(raw, "economy", doc); err != nil {
		return doc, err
	}
	return doc, contentValidate("economy", nil, doc)
}

func LoadEconomy() (*Economy, error) {
	raw, err := FS.ReadFile("economy.json")
	if err != nil {
		return nil, err
	}
	return DecodeEconomy(raw)
}

var Rules = func() *Economy {
	e, err := LoadEconomy()
	if err != nil {
		panic(err)
	}
	return e
}()

// The Habitica snapshot loads through content/habitica_gear.go; the Wilds
// generator data through content/wilds.go; the shared paper catalog through
// content/papers.go.
