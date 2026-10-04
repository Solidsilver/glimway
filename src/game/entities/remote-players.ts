/**
 * Remote players — the presence seam (interface only, no implementation yet).
 *
 * Phase 6 of docs/expansion-design.md ("Presence": WebSocket rooms, avatars
 * and emotes) will render visiting players in the world. This module is the
 * seam the design asks for: WorldScene owns one RemotePlayers instance per
 * area and drives it from its update loop; the future implementation turns
 * presence samples into layered avatar sprites — the same Habitica layer
 * stack as the hero, via avatar-render's loadWorldAvatar — with depth-by-y
 * and no physics body of their own.
 *
 * What will NOT live here: networking. The presence feed (a Fingersnap API
 * client beside src/lib/habitica/ plus server-state events on the bus) will
 * call sync() from outside; this layer only draws what it is given.
 */
import type Phaser from 'phaser'
import type { AreaId } from '../../lib/state'

/** One observed remote player: a position sample from the presence feed. */
export interface RemotePlayerSample {
  /** Stable member id within the shared world. */
  id: string
  /** Only members in the same area are rendered. */
  areaId: AreaId
  /** World position in px (same coordinates as the hero sprite). */
  x: number
  y: number
}

/** Where visiting players will be rendered once presence lands. */
export interface RemotePlayers {
  /** Apply a presence snapshot: upserts movers, removes leavers. */
  sync(samples: readonly RemotePlayerSample[]): void
  /** Per-frame update (interpolation, bob, depth-by-y) while the world is live. */
  update(dt: number): void
  /** Drop every remote sprite (area change, scene shutdown). */
  clear(): void
}

/** No-op until presence ships; keeps the seam wired and honest. */
class NoopRemotePlayers implements RemotePlayers {
  sync(_samples: readonly RemotePlayerSample[]): void {}
  update(_dt: number): void {}
  clear(): void {}
}

/** The scene hands itself in; the future renderer needs it for sprites. */
export function createRemotePlayers(_scene: Phaser.Scene): RemotePlayers {
  return new NoopRemotePlayers()
}
