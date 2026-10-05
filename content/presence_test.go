package content

import (
	"encoding/json"
	"testing"
)

func TestPresenceContent(t *testing.T) {
	p, err := LoadPresence()
	if err != nil {
		t.Fatal(err)
	}
	if p.PositionHz != 8 || len(p.Emotes) != 5 || p.MaxConnections != 128 || p.MessageBytes != 1024 {
		t.Fatal("presence defaults")
	}
	for name, change := range map[string]func(*Presence){"emotes": func(p *Presence) { p.Emotes = append(p.Emotes, p.Emotes[0]) }, "hz": func(p *Presence) { p.PositionHz = 1000 }, "connections": func(p *Presence) { p.MaxConnections = 0 }, "rooms": func(p *Presence) { p.MaxRoomPlayers = p.MaxConnections + 1 }, "message": func(p *Presence) { p.MessageBytes = 1000000 }, "queue": func(p *Presence) { p.QueueMessages = 10000 }, "idle": func(p *Presence) { p.IdleTimeoutMs = 0 }, "ping": func(p *Presence) { p.PingIntervalMs = p.IdleTimeoutMs }} {
		t.Run(name, func(t *testing.T) {
			var copy Presence
			b, _ := json.Marshal(p)
			json.Unmarshal(b, &copy)
			change(&copy)
			if ValidatePresence(copy) == nil {
				t.Fatal("accepted malformed presence")
			}
		})
	}
}

func TestPresenceAdmissionAndIngressBounds(t *testing.T) {
	p := PresenceRules
	if p.MaxSessionConnections != 2 || p.MaxPlayerConnections != 4 || p.RevalidateFailures != 3 || p.IncomingMessagesPerSecond != 30 || p.IncomingBurst != 60 || p.IncomingExcessMs != 5000 {
		t.Fatal("presence abuse defaults")
	}
	for _, mutate := range []func(*Presence){func(p *Presence) { p.MaxSessionConnections = 0 }, func(p *Presence) { p.MaxSessionConnections = 5 }, func(p *Presence) { p.MaxPlayerConnections = 33 }, func(p *Presence) { p.RevalidateFailures = 11 }, func(p *Presence) { p.IncomingMessagesPerSecond = 0 }, func(p *Presence) { p.IncomingBurst = 241 }, func(p *Presence) { p.IncomingExcessMs = 0 }} {
		copy := p
		mutate(&copy)
		if ValidatePresence(copy) == nil {
			t.Fatal("invalid presence policy accepted")
		}
	}
}
