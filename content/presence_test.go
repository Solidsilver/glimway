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
