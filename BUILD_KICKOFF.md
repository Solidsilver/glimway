# Fingersnap build kickoff

Source of truth: [Fingersnap Plan.md](Fingersnap%20Plan.md).

## First implementation target

Build a playable, credential-free demo of the first lantern quest using Svelte,
TypeScript, Phaser, and Vite. Include the village, woodland, and ruin; keyboard
and touch movement; interaction and readable dialogue; local persistence; and
a visible village change after restoring the lantern.

Use original placeholder artwork with recorded provenance until third-party
assets and their individual licenses have been verified. Keep Habitica writes,
purchases, checkpoint rewind, deployment, and account credentials out of this
first implementation.

## Requested agent setup

Coordinate OpenCode through herdr. Use the configured Fireworks GLM 5.3-flash
and Xiaomi MiMo-V2.6-pro models. Discover their exact provider/model identifiers
from `opencode models`; do not substitute another model silently.

### Agent A: scaffold and game runtime

Read the game plan. Implement the Vite/Svelte/TypeScript/Phaser scaffold,
scene lifecycle, movement and collisions, camera scaling, village/woodland/ruin
transitions, and keyboard/touch input. Keep frame updates in Phaser and publish
only meaningful changes to the interface. Own build configuration and
`src/game/`. Report the interface needed from shared logic before implementing
dependent integration. Run the production build and type checks.

### Agent B: state, content, persistence, and interface

Read the game plan. Agree on shared types with Agent A, then implement
structured quest/dialogue content, a demo character, versioned IndexedDB saves,
quest journal, dialogue and character interface, save export/import without
credentials, and persistent lantern-restoration state. Own `src/lib/`,
`src/content/`, and Svelte interface files. Keep account integration disabled
and clearly explain demo mode. Test quest transitions, reload/resume, and save
validation.

### Follow-up integration research

Verify current Habitica browser access, API usage requirements, stat semantics,
art licenses and sprite composition, and Reward redemption behavior against
primary sources. Record evidence and uncertainty before implementing the
adapter. Never claim exactly-once purchase behavior without evidence.

## Acceptance checks

- A clean install, type check, and production build succeed.
- A player can complete the lantern quest from beginning to end.
- Reloading resumes quest progress and the village's restored state.
- Keyboard and touch controls work; dialogue pauses movement.
- Original placeholder assets have provenance recorded.
- Demo play makes no Habitica requests and needs no credentials.
- Browser playtesting covers scene changes, collisions, dialogue, resize, and
  save recovery, beyond unit tests.

## Session status

The initial sandbox blocker was resolved when the session was reopened with
filesystem and network access. Two OpenCode agents are now running in separate
herdr tabs:

- `snap_runtime`: `fireworks-ai/accounts/fireworks/models/glm-5p3-flash`.
- `snap_state`: `xiaomi/mimo-v2.6-pro`.

The user prefers separate tabs for agent work. Preserve focus in the coordinator
tab and use separate tabs for future agents.
