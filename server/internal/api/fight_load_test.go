package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"runtime/metrics"
	"runtime/pprof"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"glimway/server/internal/chunks"
	chunkwire "glimway/server/internal/gen/glimway/v1"
	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"
)

// The load groups' shared chunk: its whole 3×3 is generated ground inside the
// frontier (south limit 0, reach 3 from the footprints), so every observer
// covers nine camp rooms, one of them active.
const fightLoadCX, fightLoadCY = 3, -4

// Distances from the camp point (fights.Camp X/Y: tile centre, tile bottom).
// Warm-up stands where scaling counts but nothing aggroes; the measured run
// orbits inside aggro.
const fightLoadWarmRadius, fightLoadOrbitRadius = 150.0, 65.0

// Deliberately opt-in: real authenticated sockets and isolated SQLite, not a
// benchmark of Room.Step alone. No real credentials or external server.
func TestFightBotLoad(t *testing.T) {
	if os.Getenv("GLIMWAY_FIGHT_LOAD") != "1" {
		t.Skip("run scripts/fight-load.sh for the isolated socket load scenario")
	}
	integer := func(name string, fallback int) int {
		if os.Getenv(name) == "" {
			return fallback
		}
		n, err := strconv.Atoi(os.Getenv(name))
		if err != nil || n < 1 {
			t.Fatalf("invalid %s", name)
		}
		return n
	}
	groups := integer("FIGHT_LOAD_GROUPS", 3)
	duration := time.Duration(integer("FIGHT_LOAD_SECONDS", 20)) * time.Second
	perCamp := integer("FIGHT_LOAD_PLAYERS", 3)
	// FIGHT_LOAD_MAX_CONNECTIONS lifts the hub's socket cap for this run
	// only (content/presence.json and the proto bound stay as they are):
	// past the cap, the groups limit is that many sockets.
	maxConnections := integer("FIGHT_LOAD_MAX_CONNECTIONS", 0)
	maxGroups := 100
	if maxConnections > 0 {
		maxGroups = max(maxGroups, maxConnections/perCamp)
	}
	if groups > maxGroups || perCamp > 5 || duration > 10*time.Minute {
		t.Fatal("load parameters exceed tool limits")
	}
	x := newRig(t)
	x.api.Config.Logger = log.New(io.Discard, "", 0)
	// Every fake account signs in from the one test address; the sign-in
	// limits are not what this measures.
	x.api.Config.LoginRate, x.api.Config.LoginGlobalRate, x.api.Config.LoginPartyRate = 1<<20, 1<<20, 1<<20
	began := time.Now()
	clock := func() time.Time { return time.Unix(rigStart, 0).Add(time.Since(began)) }
	x.api.Config.Now = clock
	x.api.Config.Chunks = fightLoadChunks{x.api.Config.Chunks}
	// Slowdown shows as lateness before it shows as failure: each bot keeps
	// how old the active room's deltas are on arrival (the server stamps
	// the tick it stepped, on the rig's clock) and how long its swings
	// wait for their result. Both are measured-run samples only.
	type bot struct {
		conn                          *websocket.Conn
		slot, group                   int
		bytes, results, joins, swings atomic.Uint64
		tick                          atomic.Uint32
		warm                          atomic.Bool  // has the active room's join
		campRows                      atomic.Int32 // most rows the active room showed at once
		lags, latencies               []float64    // ms; reader-owned until done
		swung                         sync.Mutex
		sent                          map[uint32]time.Time
	}
	var measuring atomic.Bool
	// Cold start is serial: every chunk wakes one at a time behind
	// h.fightLoad and the one SQLite connection, and a reader waits in its
	// sync until its 3x3 is awake. A reader stuck longer than the ping
	// interval plus the pong wait never reads its pong and is kicked
	// (pong-timeout), so groups start reporting a few at a time: released
	// is the first group that may not report yet, raised as groups warm.
	var released atomic.Int64
	const groupsInFlight = 8
	released.Store(groupsInFlight)
	// Design 1.3: the base mix is three; each extra account within 160 px at
	// first aggro adds one, up to five.
	expectedCamp := int32(min(5, 3+perCamp-1))
	bots := make([]*bot, 0, groups*perCamp)
	cfg := presenceTestConfig()
	cfg.RevalidateMs = 60000
	ts := startPresence(t, x, cfg)
	if maxConnections > 0 {
		// The hub validates and clones its config, so the lift goes on the
		// hub's own copy, after the proto bound was checked. Past the cap
		// the cold start (every chunk woken serially behind h.fightLoad and
		// the one SQLite connection, while every reader waits) outlasts the
		// 60 s idle timeout, so the scenario lifts that too; it is the
		// harness's start-up, not steady state.
		x.api.presence.config.MaxConnections = int32(maxConnections)
		x.api.presence.config.IdleTimeoutMs = int32((10 * time.Minute).Milliseconds())
	}
	area := fmt.Sprintf("wilds:%d:%d", fightLoadCX, fightLoadCY)
	// live ends the bots' writing; measure starts the measured run.
	live, stopLive := context.WithCancel(context.Background())
	defer stopLive()
	read, stopRead := context.WithCancel(context.Background())
	defer stopRead()
	measure := make(chan struct{})
	var done sync.WaitGroup
	var failed atomic.Uint64
	// The first failure's error says what closed the socket (the server's
	// close code and reason travel in it).
	var firstFailure atomic.Pointer[string]
	fail := func(err error) {
		if live.Err() == nil {
			failed.Add(1)
			if err != nil {
				text := err.Error()
				firstFailure.CompareAndSwap(nil, &text)
			}
		}
	}
	// A bot reads from the moment it is dialed: a websocket client that is
	// not reading answers no ping, and the server kicks it (pong-timeout)
	// 25 s after its first ping, long before thousands of accounts exist.
	reader := func(b *bot) {
		defer done.Done()
		// The active room is the bots' own chunk; fakegen gives it one camp,
		// so its row count is that camp's size.
		var active uint32
		rows := map[uint32]bool{}
		note := func() {
			if n := int32(len(rows)); n > b.campRows.Load() {
				b.campRows.Store(n)
			}
		}
		for {
			_, data, err := b.conn.Read(read)
			if err != nil {
				fail(err)
				return
			}
			m, err := decodePresence(data)
			if err != nil {
				fail(err)
				return
			}
			switch e := m.Event.(type) {
			case *wire.PresenceMessage_FightJoin:
				b.joins.Add(1)
				b.tick.Store(e.FightJoin.Tick)
				if k := e.FightJoin.RoomKey; k != nil && k.Cx == fightLoadCX && k.Cy == fightLoadCY {
					active = e.FightJoin.Room
					clear(rows)
					for _, row := range e.FightJoin.Enemies {
						rows[row.Enemy] = true
					}
					note()
					b.warm.Store(true)
				}
			case *wire.PresenceMessage_FightDelta:
				b.tick.Store(e.FightDelta.Tick)
				if active != 0 && e.FightDelta.Room == active {
					if measuring.Load() {
						nowTick, offset := rules.FightTickAt(clock().UnixMilli())
						b.lags = append(b.lags, float64(rules.FightTickDiff(nowTick, e.FightDelta.Tick))*rules.FightTickMs+float64(offset))
					}
					for _, row := range e.FightDelta.Spawned {
						rows[row.Enemy] = true
					}
					for _, enemy := range e.FightDelta.Removed {
						delete(rows, enemy)
					}
					note()
				}
			case *wire.PresenceMessage_FightSwingResult:
				b.results.Add(1)
				b.swung.Lock()
				at, ok := b.sent[e.FightSwingResult.SwingCounter]
				delete(b.sent, e.FightSwingResult.SwingCounter)
				b.swung.Unlock()
				if ok {
					b.latencies = append(b.latencies, float64(time.Since(at).Microseconds())/1000)
				}
			case *wire.PresenceMessage_FightEvent:
			default:
				continue
			}
			b.bytes.Add(uint64(len(data)))
		}
	}
	// Rooms are keyed by world: one world per group gives every group the same
	// physical workload and independent rooms, however many groups run.
	for g := 0; g < groups; g++ {
		var world string
		for p := 0; p < perCamp; p++ {
			id := fmt.Sprintf("fight-load-%d-%d", g, p)
			cookie, state := x.ready(id)
			if p == 0 {
				if err := x.db.DB.QueryRow("SELECT world_id FROM players WHERE account_id=?", x.account(id)).Scan(&world); err != nil {
					t.Fatal(err)
				}
			} else if _, err := x.db.DB.Exec("UPDATE players SET world_id=? WHERE account_id=?", world, x.account(id)); err != nil {
				t.Fatal(err)
			}
			b := &bot{conn: dialFightBot(t, ts, cookie, state.Lease, area), slot: p, group: g, sent: map[uint32]time.Time{}}
			bots = append(bots, b)
			done.Add(1)
			go reader(b)
		}
	}
	campX, campY := float64(fightLoadCX*384+200), float64(fightLoadCY*384+208)
	for _, b := range bots {
		done.Add(1)
		go func(b *bot) {
			defer done.Done()
			step := time.NewTicker(100 * time.Millisecond)
			defer step.Stop()
			// Warm-up spots spread over the camp's west arc (120°–240°): inside
			// the 160 px scale band, outside the wisps' 90 px and the east-side
			// beetle's 130 px aggro, so no enemy starts the camp before the room
			// covers every observer.
			angle := math.Pi
			if perCamp > 1 {
				angle = 2*math.Pi/3 + float64(b.slot)*(2*math.Pi/3)/float64(perCamp-1)
			}
			radius := fightLoadWarmRadius
			measuring := false
			var n, walked, counter uint32
			send := func(m proto.Message) bool {
				data, err := encodePresence(m)
				if err == nil {
					ctx, cancel := context.WithTimeout(live, time.Second)
					err = b.conn.Write(ctx, websocket.MessageBinary, data)
					cancel()
				}
				if err != nil {
					fail(err)
				}
				return err == nil
			}
			for released.Load() <= int64(b.group) {
				select {
				case <-live.Done():
					return
				case <-step.C:
				}
			}
			for {
				select {
				case <-live.Done():
					return
				case <-step.C:
					if !measuring {
						select {
						case <-measure:
							measuring = true
						default:
						}
					}
					// Cold start: one report wakes the 3x3; until the join
					// arrives, further reports only queue behind the serialized
					// wake. One a second keeps the socket alive without a backlog.
					n++
					if !b.warm.Load() && n%10 != 1 {
						continue
					}
					theta := angle
					if measuring {
						// Walk in (within the 40 px/tick movement cap), then orbit.
						walked++
						theta += float64(walked) * .06
						radius = max(fightLoadOrbitRadius, radius-20)
					}
					px, py := campX+radius*math.Cos(theta), campY+radius*math.Sin(theta)
					fx, fy, moving := math.Cos(theta), math.Sin(theta), measuring
					if !send(&wire.PresencePosition{X: &px, Y: &py, Facing: &wire.PresenceFacing{X: &fx, Y: &fy}, Moving: &moving}) {
						return
					}
					if measuring && walked%10 == 0 && b.tick.Load() != 0 {
						// Outward swings exercise real dispatch/results without intentionally
						// clearing the camp, keeping the movement workload alive.
						counter++
						b.swung.Lock()
						b.sent[counter] = time.Now()
						b.swung.Unlock()
						if !send(&wire.FightSwing{Kind: wire.FightSwingKind_FIGHT_SWING_KIND_SLASH, X: px, Y: py, Facing: &wire.FightFacing{X: fx, Y: fy}, SwingCounter: counter, SeenTick: b.tick.Load()}) {
							return
						}
						b.swings.Add(1)
					}
				}
			}
		}(b)
	}
	// Wake is serialized per sync, so the first observer can be joined well
	// before the last. Nobody approaches until every bot has the active room.
	// Every chunk is cold and wakes serially (one load at a time, behind
	// the one SQLite connection, slower the more sockets contend), so the
	// budget is progress: the warm-up fails once no bot has warmed for 30 s.
	progress, lastCold := time.Now(), -1
	for poll := time.NewTicker(20 * time.Millisecond); ; <-poll.C {
		cold, warmGroups := 0, 0
		for g := 0; g < groups; g++ {
			warm := true
			for _, b := range bots[g*perCamp : (g+1)*perCamp] {
				if !b.warm.Load() {
					cold++
					warm = false
				}
			}
			if warm && warmGroups == g {
				warmGroups++
			}
		}
		released.Store(int64(warmGroups + groupsInFlight))
		if cold == 0 {
			poll.Stop()
			break
		}
		if cold != lastCold {
			progress, lastCold = time.Now(), cold
		}
		if time.Since(progress) > 30*time.Second {
			first := ""
			if text := firstFailure.Load(); text != nil {
				first = *text
			}
			t.Fatalf("%d of %d bots never joined their active room while warming (socket failures %d; first: %q)", cold, len(bots), failed.Load(), first)
		}
	}
	time.Sleep(500 * time.Millisecond) // a few more covered positions per observer
	cpuBefore := fightLoadCPU()
	// FIGHT_LOAD_CPUPROFILE profiles the measured run only: no account
	// creation or warm-up. It conflicts with go test's own -cpuprofile.
	if path := os.Getenv("FIGHT_LOAD_CPUPROFILE"); path != "" {
		f, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := pprof.StartCPUProfile(f); err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		defer pprof.StopCPUProfile()
	}
	measuring.Store(true)
	close(measure)
	time.Sleep(duration)
	// Snapshot while every socket is still connected, then stop the bots.
	cpu := fightLoadCPU().sub(cpuBefore)
	pprof.StopCPUProfile()
	heap, goroutines := fightLoadMemory()
	measured := x.api.FightMeasurements()
	var bytes, results, swings, maxBytes uint64
	joinless, wrongCamp := 0, 0
	campMin, campMax := int32(math.MaxInt32), int32(0)
	for _, b := range bots {
		n := b.bytes.Load()
		bytes += n
		maxBytes = max(maxBytes, n)
		results += b.results.Load()
		swings += b.swings.Load()
		if b.joins.Load() == 0 {
			joinless++
		}
		rows := b.campRows.Load()
		campMin, campMax = min(campMin, rows), max(campMax, rows)
		if rows != expectedCamp {
			wrongCamp++
		}
	}
	stopLive()
	stopRead()
	done.Wait()
	var lags, latencies []float64
	for _, b := range bots {
		lags = append(lags, b.lags...)
		latencies = append(latencies, b.latencies...)
	}
	lagP50, lagP95, lagMax := fightLoadPercentiles(lags)
	latencyP50, latencyP95, latencyMax := fightLoadPercentiles(latencies)
	report := struct {
		FightMeasurement
		Cores                 int     `json:"cores"`
		Groups                int     `json:"groups"`
		Bots                  int     `json:"bots"`
		RunSeconds            float64 `json:"runSeconds"`
		AwakeRoomsPerCore     float64 `json:"awakeRoomsPerCore"`
		CPUBusyPercent        float64 `json:"cpuBusyPercent"`
		FightBytesPerSecond   float64 `json:"fightBytesPerSecond"`
		MeanBotBytesPerSecond float64 `json:"meanBotBytesPerSecond"`
		MaxBotBytesPerSecond  float64 `json:"maxBotBytesPerSecond"`
		ExpectedCampSize      int32   `json:"expectedCampSize"`
		CampSizeMin           int32   `json:"campSizeMin"`
		CampSizeMax           int32   `json:"campSizeMax"`
		BotsWrongCampSize     int     `json:"botsWrongCampSize"`
		Swings                uint64  `json:"swings"`
		SwingResults          uint64  `json:"swingResults"`
		BotsWithoutFightJoin  int     `json:"botsWithoutFightJoin"`
		SocketFailures        uint64  `json:"socketFailures"`
		FirstSocketFailure    string  `json:"firstSocketFailure,omitempty"`
		DeltaLagSamples       int     `json:"deltaLagSamples"`
		DeltaLagP50Ms         float64 `json:"deltaLagP50Ms"`
		DeltaLagP95Ms         float64 `json:"deltaLagP95Ms"`
		DeltaLagMaxMs         float64 `json:"deltaLagMaxMs"`
		ResultLatencySamples  int     `json:"resultLatencySamples"`
		ResultLatencyP50Ms    float64 `json:"resultLatencyP50Ms"`
		ResultLatencyP95Ms    float64 `json:"resultLatencyP95Ms"`
		ResultLatencyMaxMs    float64 `json:"resultLatencyMaxMs"`
		HeapInUseBytes        uint64  `json:"heapInUseBytes"`
		HeapBytesPerBot       float64 `json:"heapBytesPerBot"`
		Goroutines            int     `json:"goroutines"`
	}{measured, runtime.GOMAXPROCS(0), groups, len(bots), duration.Seconds(), float64(measured.AwakeRooms) / float64(runtime.GOMAXPROCS(0)), cpu.busyPercent(), float64(bytes) / duration.Seconds(), float64(bytes) / float64(len(bots)) / duration.Seconds(), float64(maxBytes) / duration.Seconds(), expectedCamp, campMin, campMax, wrongCamp, swings, results, joinless, failed.Load(), firstFailureText(firstFailure.Load()), len(lags), lagP50, lagP95, lagMax, len(latencies), latencyP50, latencyP95, latencyMax, heap, float64(heap) / float64(len(bots)), goroutines}
	data, _ := json.Marshal(report)
	fmt.Printf("FIGHT_LOAD %s\n", data)
	if report.SocketFailures != 0 || report.BotsWithoutFightJoin != 0 || report.AwakeRooms == 0 || report.Ticks == 0 || report.SwingResults == 0 {
		t.Fatal("load did not exercise active rooms and completed swings for every bot")
	}
	if report.BotsWrongCampSize != 0 {
		t.Fatalf("active camps did not scale to %d for every observer", expectedCamp)
	}
}

func firstFailureText(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// fightLoadPercentiles: p50, p95 and max of the samples (zero when none).
func fightLoadPercentiles(samples []float64) (p50, p95, maxed float64) {
	if len(samples) == 0 {
		return 0, 0, 0
	}
	sorted := slices.Clone(samples)
	slices.Sort(sorted)
	at := func(p int) float64 { return sorted[(p*len(sorted)+99)/100-1] }
	return at(50), at(95), sorted[len(sorted)-1]
}

// dialFightBot authenticates and joins on the test goroutine. Nothing else
// reads the socket, so the bot's own reader sees every later frame.
func dialFightBot(t *testing.T, ts *httptest.Server, c *http.Cookie, lease, area string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws", &websocket.DialOptions{HTTPHeader: http.Header{"Cookie": {c.String()}, "Origin": {ts.URL}}, Subprotocols: []string{presenceProtocol}})
	if err != nil {
		t.Fatal(err)
	}
	conn.SetReadLimit(131072)
	t.Cleanup(func() { conn.CloseNow() })
	exchange := func(m proto.Message, want func(*wire.PresenceMessage) bool) {
		data, err := encodePresence(m)
		if err == nil {
			err = conn.Write(ctx, websocket.MessageBinary, data)
		}
		if err == nil {
			_, data, err = conn.Read(ctx)
		}
		var got *wire.PresenceMessage
		if err == nil {
			got, err = decodePresence(data)
		}
		if err != nil || !want(got) {
			t.Fatal("bot handshake", area, err, got)
		}
	}
	exchange(&wire.PresenceAuth{Lease: lease}, func(m *wire.PresenceMessage) bool { return m.GetReady() != nil })
	exchange(&wire.PresenceJoin{Area: area}, func(m *wire.PresenceMessage) bool { return m.GetRoom() != nil })
	return conn
}

// fightLoadCPU is the runtime's CPU accounting: busy is every P's time not
// idle, so it includes the in-process bots as well as the server. The
// runtime folds these estimates in at GC, so each sample forces one.
type fightLoadCPUSample struct{ total, idle float64 }

func fightLoadCPU() fightLoadCPUSample {
	runtime.GC()
	s := []metrics.Sample{{Name: "/cpu/classes/total:cpu-seconds"}, {Name: "/cpu/classes/idle:cpu-seconds"}}
	metrics.Read(s)
	return fightLoadCPUSample{s[0].Value.Float64(), s[1].Value.Float64()}
}

// fightLoadMemory: live heap after a collection (bots' buffers included)
// and the goroutine count, at the end of the measured run.
func fightLoadMemory() (uint64, int) {
	runtime.GC()
	s := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
	metrics.Read(s)
	return s[0].Value.Uint64(), runtime.NumGoroutine()
}

func (a fightLoadCPUSample) sub(b fightLoadCPUSample) fightLoadCPUSample {
	return fightLoadCPUSample{a.total - b.total, a.idle - b.idle}
}
func (a fightLoadCPUSample) busyPercent() float64 {
	if a.total <= 0 {
		return 0
	}
	return 100 * (a.total - a.idle) / a.total
}

// Three base enemies + two nearby friends make the five-enemy budget case.
type fightLoadChunks struct{ chunks.ChunkSource }

func (s fightLoadChunks) Chunk(ctx context.Context, tx *sql.Tx, world, epoch string, layer, cx, cy int32) (*chunkwire.WildsChunk, error) {
	c, err := s.ChunkSource.Chunk(ctx, tx, world, epoch, layer, cx, cy)
	if err != nil {
		return nil, err
	}
	c = proto.Clone(c).(*chunkwire.WildsChunk)
	for _, e := range c.Entities {
		if e.Kind == "camp" {
			e.Enemies = []string{"wisp", "beetle", "wisp"}
		}
	}
	return c, nil
}
