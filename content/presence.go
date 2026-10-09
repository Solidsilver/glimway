package content

import (
	contentv1 "glimway/gen/glimway/content/v1"
)

type Presence = contentv1.Presence

// DecodePresence reads presence JSON into the generated type, refusing
// nulls and unknown keys, then runs the schema's rules. There are no rules
// left in code: the bounds, the emote vocabulary and uniqueness, and the
// capacity/ping orderings are all on the schema.
func DecodePresence(raw []byte) (*Presence, error) {
	doc := &Presence{}
	if err := decodeContentProto(raw, "presence", doc); err != nil {
		return doc, err
	}
	return doc, contentValidate("presence", nil, doc)
}

// ValidatePresence re-runs the schema's rules on a hand-built policy (the
// presence hub validates a config from the server flags the same way).
func ValidatePresence(p *Presence) error {
	return contentValidate("presence", nil, p)
}

func LoadPresence() (*Presence, error) {
	raw, err := FS.ReadFile("presence.json")
	if err != nil {
		return nil, err
	}
	return DecodePresence(raw)
}

var PresenceRules = func() *Presence {
	p, err := LoadPresence()
	if err != nil {
		panic(err)
	}
	return p
}()
