/**
 * A sound cue, said on the bus. Scenes, entities and panels call `sfx(cue)`
 * where no richer event fits; the sound module (src/game/sound.ts) decides
 * whether and how it plays. Nothing here touches audio.
 */
import { bus, EV } from './events.ts'
import type { SoundCue } from './sound-bank.ts'

export type SfxCue = SoundCue

export function sfx(cue: SfxCue): void {
  bus.emit(EV.sfx, { cue })
}

/** Dialogue typing blip in the speaker's voice (the module keeps it a soft patter). */
export function voiceBlip(speaker: string): void {
  bus.emit(EV.sfx, { cue: 'voice', speaker })
}

/** Shared reduced-motion check for shakes, hit-stop and big tweens. */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
