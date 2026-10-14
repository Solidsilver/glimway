# Standalone edition and native clients (a possible future)

2026-10-14. Notes from a conversation with the owner. **Nothing here is planned or scheduled.** It records an idea and what we learned about it, so it's ready if we come back to it.

## The idea

A version of Glimway just for playing the content, with no Habitica integration or limits. It would ship on Mac, Windows, iOS, Android and the web, through Steam and the app stores.

## What carries over

**The server mostly does.** Since 0.8 and the seamless-world work, the Go server is authoritative for the world, chunks, fights, the economy and saves, and the protobuf contract describes everything on the wire. Habitica is tied into these places (about 26 files in `server/internal/api`, plus the store, rules and profile):

- **Accounts and sign-in.** Today a player is a Habitica user. A standalone edition needs its own accounts, or Steam, Apple and Google sign-in.
- **The economy.** Gold top-ups and rewards come from real-life tasks. Without Habitica, something in the game has to pay players, and the pacing needs redesigning. This is a design problem more than an engineering one, and the hardest part of the server work.
- **Parties and worlds.** World membership follows Habitica parties.

This should be a **server mode, not a fork**. That matches the owner's guest-mode decision of 2026-10-13: "a future guest or non-Habitica mode will be server-side, like the Habitica mode is now."

**The client is bigger than rendering.** It's about 80k lines: `src/game` 42k, `src/ui` 20k and `src/lib` 17k. Besides drawing, it does:
- prediction: movement, collision, and local results shown before the server answers;
- the offline outbox;
- code-drawn textures;
- avatar compositing;
- dialogue and story beats;
- Brackenwood's story fights, which still run on the client;
- NPC routines, the map, and every UI panel.

Several rules exist twice, once in Go and once in TypeScript, for prediction.

## Options considered

| Option | Notes |
|---|---|
| **Wrap the current client** | Tauri or Electron for desktop and Steam, Capacitor for iOS and Android. About 2–4 weeks with agents, with one client to maintain. Still on the table. |
| **Bevy (Rust)**, the owner's preference for a rewrite | Covers Mac, Windows, iOS, Android and web through WASM. 2D sprites and tilemaps are its strength (`bevy_ecs_tilemap` for chunk layers). Rust performs well on phones. |
| Godot 4 (GDScript) | The best all-rounder, with a strong UI system. C# didn't export to web (check again). Web builds are larger. |
| Cocos Creator (TypeScript) | Would reuse the TypeScript rules and generated contract code. Strong on web and mobile; its tools are rougher. |
| Defold (Lua) | The leanest and fastest on phones and the web, but its GUI is basic. |
| Flutter + Flame | Excellent for UI; average for a busy tile world on the web. |

## Bevy specifics

- **Contract.** prost generates Rust types from the existing `.proto` files and works on WASM. Add the Buf community plugin `buf.build/community/neoeinstein-prost` (and `prost-serde` if JSON is needed) to `buf.gen.yaml`, beside Go and TypeScript, so all three come from one contract.
- **Networking.** On the web, Rust is limited to WebSocket or WebTransport, like today's client, so the speed advantage shows on native builds only. Today's websocket and presence protocol work unchanged through a crate that covers both native and browser (for example `ewebsock`).
- **UI.** `bevy_egui` with heavy custom styling. It's very customizable, but a cozy look needs a real design budget. The owner thinks that's doable.
- **Shared rules.** The prediction rules (collision, placement and the like) could be written once in Rust and compiled to WASM, so today's web client could use them too. Rules would then live in Go and Rust, not Go, TypeScript and a third language.
- **Watch for:** Bevy's breaking releases every few months, so plan for migration work; large WASM builds (often 10–30 MB before `wasm-opt` and compression); and mobile being the least polished target.

## Distribution notes

- Apple requires Sign in with Apple when other social logins are offered, and account deletion inside the app.
- In-app sales go through the stores' payment rules.
- A desktop build could run the Go server locally against SQLite for offline single-player.
- More players means the single live server needs the work in [scaling.md](scaling.md).

## The standing cost

Any rewrite means two clients, so every feature lands twice until the web client is retired or replaced by the Bevy web build. Do the server's standalone mode first. It's useful whichever client path is chosen.
