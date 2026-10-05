package content

import (
	"encoding/json"
	"fmt"
)

type Presence struct {
	MaxSessionConnections     int      `json:"maxSessionConnections"`
	MaxPlayerConnections      int      `json:"maxPlayerConnections"`
	RevalidateFailures        int      `json:"revalidateFailures"`
	IncomingMessagesPerSecond int      `json:"incomingMessagesPerSecond"`
	IncomingBurst             int      `json:"incomingBurst"`
	IncomingExcessMs          int      `json:"incomingExcessMs"`
	Emotes                    []string `json:"emotes"`
	PositionHz                int      `json:"positionHz"`
	EmoteCooldownMs           int      `json:"emoteCooldownMs"`
	JoinCooldownMs            int      `json:"joinCooldownMs"`
	MaxConnections            int      `json:"maxConnections"`
	MaxRoomPlayers            int      `json:"maxRoomPlayers"`
	MessageBytes              int      `json:"messageBytes"`
	QueueMessages             int      `json:"queueMessages"`
	AuthTimeoutMs             int      `json:"authTimeoutMs"`
	IdleTimeoutMs             int      `json:"idleTimeoutMs"`
	PingIntervalMs            int      `json:"pingIntervalMs"`
	PongTimeoutMs             int      `json:"pongTimeoutMs"`
	LeaveGraceMs              int      `json:"leaveGraceMs"`
	RevalidateMs              int      `json:"revalidateMs"`
	WriteTimeoutMs            int      `json:"writeTimeoutMs"`
}

func ValidatePresence(p Presence) error {
	bad := fmt.Errorf("invalid presence")
	if len(p.Emotes) == 0 || len(p.Emotes) > 16 || p.PositionHz < 1 || p.PositionHz > 20 || p.MaxConnections < 1 || p.MaxConnections > 512 || p.MaxRoomPlayers < 1 || p.MaxRoomPlayers > p.MaxConnections || p.MessageBytes < 128 || p.MessageBytes > 4096 || p.QueueMessages < 4 || p.QueueMessages > 128 {
		return bad
	}
	for _, b := range []struct{ n, max int }{{p.MaxSessionConnections, 16}, {p.MaxPlayerConnections, 32}, {p.RevalidateFailures, 10}, {p.IncomingMessagesPerSecond, 120}, {p.IncomingBurst, 240}} {
		if b.n < 1 || b.n > b.max {
			return bad
		}
	}
	if p.MaxSessionConnections > p.MaxPlayerConnections {
		return bad
	}
	for _, n := range []int{p.IncomingExcessMs, p.EmoteCooldownMs, p.JoinCooldownMs, p.AuthTimeoutMs, p.IdleTimeoutMs, p.PingIntervalMs, p.PongTimeoutMs, p.LeaveGraceMs, p.RevalidateMs, p.WriteTimeoutMs} {
		if n < 1 || n > 120000 {
			return bad
		}
	}
	if p.PingIntervalMs >= p.IdleTimeoutMs || p.PongTimeoutMs >= p.IdleTimeoutMs {
		return bad
	}
	seen := map[string]bool{}
	for _, id := range p.Emotes {
		if !ValidContentID(id) || len(id) > 32 || seen[id] {
			return bad
		}
		seen[id] = true
	}
	return nil
}
func LoadPresence() (Presence, error) {
	var p Presence
	b, err := FS.ReadFile("presence.json")
	if err == nil {
		err = json.Unmarshal(b, &p)
	}
	if err == nil {
		err = ValidatePresence(p)
	}
	return p, err
}

var PresenceRules = func() Presence {
	p, err := LoadPresence()
	if err != nil {
		panic(err)
	}
	return p
}()
