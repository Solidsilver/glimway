package api

import (
	"sort"
	"sync"
	"time"
)

// FightMetrics keeps bounded timing samples; recording never touches the store.
type FightMetrics struct {
	mu           sync.Mutex
	samples      [2048]time.Duration
	next, count  int
	ticks, bytes uint64
	max          time.Duration
	started      time.Time
}

func NewFightMetrics() *FightMetrics { return &FightMetrics{started: time.Now()} }

type FightMeasurement struct {
	AwakeRooms     int     `json:"awakeRooms"`
	Players        int     `json:"players"`
	Ticks          uint64  `json:"ticks"`
	TickSamples    int     `json:"tickSamples"`
	TickP95Ms      float64 `json:"tickP95Ms"`
	TickMaxMs      float64 `json:"tickMaxMs"`
	OutboundBytes  uint64  `json:"outboundBytes"`
	ElapsedSeconds float64 `json:"elapsedSeconds"`
}

func (a *Server) RecordFightTick(d time.Duration) {
	m := a.Config.FightMetrics
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.samples[m.next] = d
	m.next = (m.next + 1) % len(m.samples)
	m.count = min(m.count+1, len(m.samples))
	m.ticks++
	m.max = max(m.max, d)
}

// RecordFightBytes counts serialized fight bytes admitted to a player's queue.
func (a *Server) RecordFightBytes(n int) {
	m := a.Config.FightMetrics
	if m == nil || n <= 0 {
		return
	}
	m.mu.Lock()
	m.bytes += uint64(n)
	m.mu.Unlock()
}

func (a *Server) FightMeasurements() FightMeasurement {
	var out FightMeasurement
	if a.presence != nil {
		a.presence.mu.Lock()
		out.AwakeRooms, out.Players = len(a.presence.fightRooms), len(a.presence.peers)
		a.presence.mu.Unlock()
	}
	if m := a.Config.FightMetrics; m != nil {
		m.mu.Lock()
		samples := append([]time.Duration(nil), m.samples[:m.count]...)
		out.Ticks, out.TickSamples, out.TickMaxMs = m.ticks, m.count, float64(m.max)/float64(time.Millisecond)
		out.OutboundBytes, out.ElapsedSeconds = m.bytes, time.Since(m.started).Seconds()
		m.mu.Unlock()
		if len(samples) > 0 {
			sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
			out.TickP95Ms = float64(samples[(95*len(samples)+99)/100-1]) / float64(time.Millisecond)
		}
	}
	return out
}
