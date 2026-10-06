import { bus, EV } from '../game/events'
import { held, heldNow, type HeldPayload } from '../game/held'
import type { BeltSlot, BeltKind } from '../lib/belt'

/**
 * What's in hand and the belt, for the interface (the action bar, the phone
 * ring, the bag): it follows EV.held from src/game/held.ts.
 */
class HeldUi {
  kind = $state<BeltKind>(heldNow().kind)
  belt = $state<BeltSlot[]>(held.belt)
  /** The slot in hand. */
  get slot(): BeltSlot {
    return this.belt.find((s) => s.kind === this.kind) ?? this.belt[0]
  }
}

export const heldUi = new HeldUi()

bus.on(EV.held, (p: HeldPayload) => {
  heldUi.kind = p.kind
  heldUi.belt = p.belt
})
