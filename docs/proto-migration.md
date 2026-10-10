# Shared contract migration

Stage 1 adds protobuf as the transport schema, without changing HTTP's JSON
contract. Stored replay bodies stay on their raw replay path; byte compatibility
across serializer versions is no longer a migration requirement. Generated Go
messages live in
`server/internal/gen/glimway/v1`; protobuf-es emits JavaScript and TypeScript
declarations in `src/lib/gen/glimway/v1`. JavaScript plus declarations lets the
existing Node strip-only test runner import generated enums without a transpiler.

## Generating and checking

Run `npm ci`, then `npm run proto` from the repository root. Generation pins Buf
1.73.0, protoc-gen-go / the Go runtime 1.36.12, and protoc-gen-es / the JavaScript
runtime 2.12.0. Buf is an exact `@bufbuild/buf` devDependency installed by
`npm ci`, invoked via
`node_modules/.bin/buf`. The Go plugin is a `tool` in `go.mod`, invoked as
`go tool protoc-gen-go`, so it follows the same protobuf module as the runtime.
Generation uses `clean: true` to remove stale output before regenerating.
Ordinary npm, Docker and Nix builds consume the checked-in output without
invoking compilers. Include generated files when committing schema changes.
CI lints, regenerates, rejects changed/untracked generated files, and enforces
`buf breaking` against two baselines with full Git history (the
`scripts/buf-breaking.sh` step): `origin/main`, the branch's own contract, and
the latest release tag — the contract the last release shipped, which is what
players actually run. The initial migration bootstrapped that check when main
had no Buf schema yet; later runs require both contracts.

### Compatibility: what may move

Every field number and binary event number is permanent. Append fields/codes;
reserve removed names and numbers. Never renumber the error enum. `buf.yaml`
enforces the reservation (0.6.1): `breaking` uses FILE with `except:
[FIELD_NO_DELETE]` plus `FIELD_NO_DELETE_UNLESS_NUMBER_RESERVED` and
`FIELD_NO_DELETE_UNLESS_NAME_RESERVED`, so a removed field passes only once
both its number and its name are reserved. (The content
schemas and the vendored `buf/validate` are exempt from breaking checks: their
loaders change in the same commit as the files.)

A **message may move between two files of the same package** (and so between
the Go package and the protobuf-es module): its name, fields and numbers are
unchanged, so the wire form and the JSON spelling are identical — only the
generated source's imports change. Buf's FILE rule still reports the move as
a deletion from the old file, so a move is accepted explicitly, by buf's exact
line, in `scripts/buf-breaking.sh` (one line per moved message). The
acceptance is emptied once a release ships the move: the release tag baseline
then contains the moved-to file, and the recorded line matches nothing. Moves
are not a habit: keep messages in the file that owns their domain, and move
only when a dependency arrangement demands it — never in a way that creates
an import cycle between the files.

Review JSON field names as well as numbers: `buf.yaml` uses FILE breaking
checks for the wire packages, which can be run against a committed base with
`GIT_LFS_SKIP_SMUDGE=1 node_modules/.bin/buf breaking --against
'.git#ref=refs/remotes/origin/main'` (or `scripts/buf-breaking.sh` for both
baselines). Skipping LFS smudging avoids unrelated art downloads for the
comparison.
Go and TypeScript adapt enum names by removing `ERROR_CODE_`, lowercasing, and
replacing underscores with hyphens. This preserves the existing error strings;
raw protobuf enum JSON names are **not** the HTTP error vocabulary.

## Content files (glimway.content.v1)

The JSON files under `content/` are moving onto protobuf schemas one family at a
time, with their field rules as protovalidate constraints enforced identically in
both languages. The pilot moved `furnishings.json`, `rooms.json` and
`residents.json`; `.agent/PATTERN.md` is the step-by-step recipe for the rest.

- Schemas live in `proto/glimway/content/v1/` (a package separate from the wire
  versions, so content and transport move independently). The JSON files keep
  their shape; only the enforcement moves.
- Go generation goes to `gen/glimway/content/v1` (package `contentv1`) — **not**
  `server/internal/gen`, which `glimway/content` cannot import (Go's internal
  rule). Docker (`COPY gen ./gen`) and `nix/server.nix` include `gen/` for this
  reason; CI's generated-output check covers it too.
- `buf/validate/validate.proto` is vendored at `proto/buf/validate/` (BSR module
  `buf.build/bufbuild/protovalidate` v1.2.0, the schema protovalidate-go v1.4.0
  pins) so builds need no network: `buf export
  buf.build/bufbuild/protovalidate:v1.2.0 -o proto`. Never generate a second Go
  copy of it — the runtimes provide their own constraint types and a second
  `RegisterFile` panics; `buf.gen.yaml` filters Go generation by package.
- The runtimes must move together: `buf.build/go/protovalidate`,
  `@bufbuild/protovalidate` and the vendored `validate.proto` (and the generated
  TS copy). A rule one runtime doesn't know is silently ignored there. The
  vector tests' rule-id assertions and `tests/validate-lockstep.test.ts` guard
  this.
- Go loaders: `content/protojson.go` (`decodeContentProto` — refuses nulls and
  non-canonical keys pre-parse, then protojson — and `contentValidate`, built
  once per process) plus each family's `Decode*` with the rules that stay in
  code. TS loaders: `src/lib/content-proto.ts` (`decodeContent`), same split.
  `tests/helpers/vector-rule.ts` asserts the shared vectors refuse for the
  same named rule in both languages.

## Migrated surface

- All presence events, including gift and witness, use generated binary payloads.
  Connections must negotiate `glimway.presence.v1`; no or incompatible protocol
  closes with **4005 (`reload-needed`)**. The client treats it as terminal and
  latches the lease; the versioning lane owns the reload prompt. There is no JSON
  fallback. Authentication remains the first frame and the lease never goes in
  the URL. Codes 4001–4004, admission, cooldowns, authentication checks, reconnect
  behavior and bounded queues retain their existing roles. Encode each broadcast
  once and share immutable bytes across recipient queues. Position/emote encoding
  happens before taking the hub lock; room snapshots and membership changes stay
  serialized under it to preserve event order.
- The error enum owns the complete refusal catalog. The production-source scan
  still checks every literal and explicitly tracked dynamic refusal against it.
  The client derives its string union and runtime catalog from generated code.
- `GET /api/calendar` uses a generated Go response and generated TS decoding.
  `CalendarAt` remains a pure content calculation; a boundary adapter maps its
  result to the generated HTTP message. The old HTTP interface and parser have
  been removed from `types.ts` and `parse.ts`, with compatibility re-exports for
  existing imports. Wrappers preserve `festival` and `notice` as string or null;
  numeric Unix seconds remain numbers, including dates beyond 2038. The Go
  serializer emits zero scalars and unpopulated collections/message fields.
- `GET/POST /api/invites` use generated metadata/list/creation messages and TS
  decoding. Original-handler fixtures cover empty lists, used and unused entries,
  zero metadata times and remaining quota, party flags, and post-2038 numeric
  timestamps. Creation retains the one-time raw code; reads never include it.
  All list fields are always present, including explicit false booleans. The
  pre-deploy older-server quota fallback was removed: missing or malformed current
  fields are `bad-response`; additional future fields are ignored. Revocation
  remains on its existing response path until the world-selection slice.

The golden calendar fixtures were captured from the original handler before
its conversion. Frozen error vocabulary and presence event fixtures, plus
Go-produced binary oracles, are consumed by both languages. A separate real-peer
hub fixture test reads the actual raw binary frames for room/avatar/null-pos,
join, pos, emote, leave, gift and witness events. It compares generated messages
and projected fixture keys, so unset optional false/zero fields fail. JSON here
is only a readable fixture representation. Frozen fixtures must not be
regenerated to make a regression pass.

## Remaining order

| Order | Domain | Work and main risks |
| --- | --- | --- |
| Done | Small leaf: invite metadata/read/create | Generated Go/TS contract with frozen original-handler HTTP fixtures. |
| 2 | Session, identity and snapshot envelope | Split into profile, progress, save and envelope sub-slices, each with its own zero/null/omission fixtures. Keep all existing `validateSave` and Habitica semantic validation after generated decoding. |
| 3 | Hearthwick library | Capture read/donate, empty shelves and stored replay fixtures. Generate shelf entries and read/donation response/request messages; move `src/lib/papers/library.ts`'s remote library onto the generated contract and common API transport. Keep its paper lookup/filtering, display-name cap, timestamps and duplicate-donation behavior. The library currently embeds snapshots and has its own fetch/error handling; migrate those deliberately after the envelope. |
| 4 | Invite revocation and world selection/moves | Reuse invite metadata; quotas, absent older-server fields, world prompts and choice unions need fixtures for every branch. Preserve names, nullable party membership, numeric cooldowns, and redirects/statuses. |
| 5 | Items, assets, storage and crafting | Generate reusable asset/instance/maker/slot types before action responses. Cover every wear state and optional result member. Preserve numeric quantities, count maps, null maker/slot fields, empty lists, and raw stored replays. |
| 6 | Homesteads, Commons, deeds and gate shelves | Land coordinates are JSON tuples; model proto coordinate messages with a JSON boundary adapter. Cover null homes, joint invitations, nullable times, empty gates/plants/slots, furniture placement unions and multiple storage views. |
| 7 | Mail, projects and repairs | Cover old mail rows lacking return fields, nullable claim/return/completion times, cursors, optional gifts, map counts and all action branches. Reuse generated assets/workshop types. |
| 8 | Wilds and play/progress/sync/spend | Capture each high-volume result shape and persisted replay before changing writers. Preserve revision/seed precision, entity unions, loot optionals, feature flags, numeric timestamps and imported profiles. This is the broadest persisted surface; migrate in small endpoint slices. |

**Next slice:** profile, before progress, save and the snapshot envelope.

For each slice: capture the old handler's fixtures first; include zero, null,
empty, populated, omitted optional and mixed-version cases; add Go comparisons
and TS decoding of the same fixtures; replace only that slice's HTTP transport
types/decoder; keep semantic validation; run verification, relevant Go and E2E
specs, regeneration checks and packaging checks. Delete remaining hand catalogs
and the last `parse.ts` / `types.ts` compatibility facades only after all domains
have migrated. HTTP remains JSON throughout.

## Shape rules and risks

- **Numbers:** protojson emits 64-bit integers as strings. Use int32 only for
  bounded counts; use doubles for today's numeric times, revisions or seeds
  that exceed int32. Preserve safe-integer/range checks in application validation.
  Range-check at every narrowing conversion: Go's `int32(value)` silently wraps
  outside the signed 32-bit range, and converting a fractional float truncates.
  Existing calendar days and gift quantities are bounded before conversion.
- **Non-finite doubles:** ProtoJSON accepts/emits NaN and ±Inf as the strings
  `"NaN"`, `"Infinity"`, `"-Infinity"`; `encoding/json` rejects them. `writeProto`
  recursively rejects non-finite float/double values, including nested messages,
  lists and maps, with a 500 before writing a response. Keep finite-number
  validation on incoming HTTP data so numeric fields never become strings.
- **Invalid UTF-8:** `encoding/json` replaces invalid bytes with U+FFFD;
  ProtoJSON and binary protobuf reject them. An invalid outgoing HTTP string
  therefore becomes a 500; presence encoding fails with 1011. Sanitize database
  strings at domain boundaries. Existing presence names use rune-based caps and
  asset keys use bounded ASCII validation.
- **Byte stability:** ProtoJSON does not promise stable bytes between builds or
  versions; whitespace/order can vary and it does not HTML-escape like
  `encoding/json`. Compare parsed keys/types rather than serialized bytes; do
  not hash fresh ProtoJSON output as a canonical identity.
- **Zero and omission:** `EmitUnpopulated` is appropriate for always-present
  fields; it is not universal for every domain. Proto3 optional fields represent
  fields that may be absent. Wrapper/message absence can represent explicit null
  when the writer emits unpopulated fields. Document endpoint-specific policies.
  TS adapters normalize wrapper absence to the existing game's nulls.
- **Collections:** repeated fields and maps default to empty values. Always emit
  `[]` / `{}` where the old handler does. Never turn an empty array into missing or
  null. Distinguish truly optional collections in a wrapper message if needed.
- **Maps with nullable values:** presence equipment uses `google.protobuf.Value`
  so a slot's explicit null survives binary roundtrips. Other maps should use
  typed count values where possible. Do not replace an arbitrary keyed map with
  a Struct merely to avoid defining a domain schema.
- **Unions:** presence uses a oneof in its binary envelope; the client maps
  generated payloads directly into game views with `type`. HTTP unions and
  flattened action results
  need adapters to preserve their current keys rather than exposing a new oneof
  wrapper on the wire. Required proto field presence does not replace semantic
  validation or authorization.
- **Timestamps:** calendar and most save fields use numeric Unix seconds; library
  donations use RFC3339 strings. Copy those shapes. `google.protobuf.Timestamp`
  JSON may normalize fractional precision and timezone spelling; it is not a
  drop-in replacement for every existing string/time shape.
- **HTTP decoder template:** use the invite adapter's sequence for later slices:
  require the existing JSON keys and raw types (including zero/false/empty values),
  reject known proto-name aliases such as `created_at` and `outstanding_limit`
  even when the camelCase field is also present, decode with unknown future fields
  ignored, then validate the **decoded** message before projecting application
  types. Check finite times recursively, bounded integral int32 counts and
  non-negative quotas, plus each domain's semantic rules. ProtoJSON accepts
  aliases, numeric strings and non-finite strings; raw validation alone cannot
  guarantee that the decoded values satisfy the HTTP contract. Cover both alias
  key orders, nested aliases, malformed values and valid boundary values in tests.
- **Compatibility:** HTTP readers ignore future fields but still validate known
  values. New clients keep unknown error codes as `unknown`. The server keeps a
  strict presence ingress, including unknown nested binary fields. Reserve a new
  websocket subprotocol version if incoming binary compatibility must broaden.
  Rollback must restore the matching client/server protocol pair; incompatibility
  yields reload-needed rather than retrying the same rejected payload.
- **Replay:** keep stored JSON on the existing raw replay path where it is free;
  do not reserialize old bodies solely to migrate schemas. Cross-version stored
  byte compatibility is not a hard constraint now that nobody plays yet. Still
  verify key/type equality and HTTP shape for each endpoint's current responses.

The protobuf JSON mapping rules are documented in the official
[ProtoJSON guide](https://protobuf.dev/programming-guides/json/); the existing
Glimway fixtures remain the authority for this migration's public JSON shapes.
