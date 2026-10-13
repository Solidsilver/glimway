# Scaling notes (for later)

Status: not needed yet. Written 2026-10-06 from reading the code and config, not from
a load test. Glimway's worlds are small invite-only groups, and the current design
favours simple, correct behaviour over throughput.

## How the server is built today

- **One Go process, one SQLite database** in WAL mode with `SetMaxOpenConns(1)`
  (`server/internal/store/store.go`). Every database operation, reads included, goes
  through that one connection, one at a time. Writes use `_txlock=immediate` and
  `synchronous=FULL`, so every commit waits for the disk.
- **Presence** is one in-memory hub over WebSockets with a single mutex
  (`server/internal/api/presence.go`). Positions go out at 8 Hz to everyone in the same
  room. Limits live in `content/presence.json`: 128 connections per server, 32 players
  per room, 30 incoming messages per second per socket.
- **Per player:** a heartbeat every 30 s, a presence re-check every 10 s, debounced
  progress uploads, and occasional keyed mutations (crafting, gathering, mail).

## Rough capacity (estimates)

- **Database:** a write transaction costs about 1–3 ms on an SSD, mostly the disk sync,
  so about 300–1,000 writes a second. An active player writes perhaps once every
  5–10 s. Reads share the same connection, so a few hundred active players is
  comfortable.
- **Presence:** a full room is 32 × 8 Hz × 31 recipients, about 8,000 small messages a
  second, which is easy for Go.
- **The configured ceiling is 128 connections**, a deliberate cap, not a performance limit.
- **Memory:** about 20–40 MB idle, plus tens of KB per connected player. Well under
  150 MB at 128 players.
- **CPU:** a few percent of one core at party scale.
- **Disk speed matters more than CPU,** because of `synchronous=FULL`. NVMe is great,
  SATA SSD is fine, an SD card or spinning disk would be noticeably slow.

## Historical measurement: shared camp fights (2026-10-12, M1 Max)

This is one local measurement snapshot from commit `268c9b42e18f1b7f9bdd7ef82a01cd1ac5c513c6`,
not a current universal capacity claim. It used `scripts/fight-load.sh` with
`FIGHT_LOAD_FLUSH_MS=0`, three players per camp, nine awake rooms per
group, and bots in the same process. Re-run with the same hardware and settings
before comparing results. The opt-in output and test controls are documented in
[shared-fights-testing.md](shared-fights-testing.md).

`scripts/fight-load.sh` with `FIGHT_LOAD_MAX_CONNECTIONS` lifted the 128 cap in the
test only (see `docs/shared-fights-testing.md`). Three players per camp, nine awake
rooms per group, bots in the same process (about a third of the measured CPU).

- **The sim is not the bottleneck:** `Room.Step` is under 1% of CPU at 6,300 awake rooms.
- **One core is bound by socket syscalls:** one `write` per outgoing frame costs about
  40% of the core at 2,100 players, reads another 12%. Deltas start arriving more than
  a tick late (p95 over 100 ms) between 500 and 1,000 players; 2,100 saturates the core.
- **Four cores were bound by the hub mutex**, not CPU: at 2,100 players the process used
  2.5 cores yet kicked most sockets as slow consumers, because readers held `h.mu` while
  scanning every peer per position, every room output scanned every peer, and every
  position report serialized on the fight-load lock. After the fixes in that lane
  (per-world peer index, per-room viewer sets, lock-free writer accounting, wake-only
  load lock, actor submits off the lock) 2,100 players run clean on four cores with
  deltas p95 under 70 ms, and 3,000 players still deliver every swing.
- **Current flush control:** presence output can be batched at 50 or 100 ms;
  default 0 sends immediately. Set `GLIMWAY_PRESENCE_FLUSH_MS` or
  `-presence-flush-ms`. This changes queued-send timing and is a playtest/load
  knob, not a default capacity guarantee. See the server CLI and
  [shared-fights-testing.md](shared-fights-testing.md).

## Multithreaded machines

HTTP handling, JSON work and WebSocket goroutines spread across cores. The single
database connection does not, and it's the main reason extra cores wouldn't help much.
The presence hub's single mutex would show contention before the CPU runs out, but only
at hundreds of busy sockets.

## If it ever needs to scale (cheapest first)

1. **Separate read connections:** a pool of read-only connections beside the one writer.
   WAL already allows concurrent readers, and this frees reads from waiting behind writes.
2. **`synchronous=NORMAL`:** the usual setting with WAL. It still can't corrupt the
   database, but a power cut could lose the last few commits. It roughly removes the
   per-commit disk sync.
3. **Per-room locks** in the presence hub instead of one hub mutex.
4. **Shard by world:** worlds are already nearly independent, so separate processes or
   database files per world would scale close to linearly.

Before any of these, measure: a small load test that simulates N players heartbeating,
uploading progress and walking around with presence.

## Wire format: protobuf or shared schemas (historical idea, 2026-10-06)

Presence v3 now uses generated protobuf messages and a binary codec; this
section records the earlier proposal, which has shipped. See
[`server/internal/api/proto.go`](../server/internal/api/proto.go),
[`proto/glimway/v2/presence.proto`](../proto/glimway/v2/presence.proto), and
[`src/lib/gen/`](../src/lib/gen/).

The owner asked about protobuf for bandwidth, speed and shared FE/BE types.

- **Where it helps:** presence is the one hot path (positions at 8 Hz, fanned out to up
  to 31 others per room). A JSON position message is maybe 60–100 bytes, and protobuf
  would make it perhaps 15–25, which cuts bytes and server encoding CPU at full rooms.
  Shared generated types would also stop Go/TS drift. This week's bugs included new
  error codes the client didn't know and response fields parsed differently.
- **Where it helps little or costs:** REST traffic is low-frequency and dominated by
  latency and SQLite commits; gzip already shrinks JSON well. Idempotent replays store
  responses with the same JSON shape, progress is JSON in SQLite, and the parity vectors are
  JSON. JSON is readable in dev tools, logs and e2e tests. Protobuf adds a browser
  runtime and a codegen step for both sides.
- **Suggested path if ever done:** (1) binary presence only, as protobuf or a tiny
  hand-packed format, which is where nearly all the bytes are; (2) shared types for the
  REST API from one schema, either protobuf with its JSON mapping on the wire (keeps
  stored replays and debuggability) or a JSON-native schema (JSON Schema or TypeSpec)
  that generates Go and TypeScript.
