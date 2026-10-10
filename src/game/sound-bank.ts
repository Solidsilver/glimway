/**
 * What each sound cue plays: Kenney samples (CC0, public/assets/audio/kenney/,
 * listed in ASSETS.md) or one of the procedural voices in sound-web.ts.
 *
 * Every sample was trimmed and levelled to the same loudness (its loudest
 * 50 ms at -14 dBFS RMS), so `gain` here is the mix: how loud this cue sits
 * against the others. `jitter` varies the pitch (± a fraction) so repeats
 * don't sound stamped; `cap` is how many may start within `window` seconds.
 */

export const SOUND_BASE = '/assets/audio/kenney/'

/** Procedural voices (sound-web.ts). */
export type SynthCue = 'voice' | 'falter' | 'settle' | 'blip' | 'cast' | 'pop' | 'quest' | 'windup' | 'lantern' | 'defeat' | 'step-area'

/** The ground under a footstep. */
export type Ground = 'grass' | 'path' | 'stone' | 'wood'

export interface CueDef {
  /** Sample variants (one picked per play, never the same twice running). */
  files?: string[]
  synth?: SynthCue
  gain: number
  jitter?: number
  /** At most `cap` starts within `window` seconds (default 1 per 0.05 s). */
  cap?: number
  window?: number
  /** A sound of the world (not the interface): quieter while the game is paused. */
  world?: boolean
  /** Stays quiet when another cue just played (a toast's chime under its own sound). */
  yields?: boolean
}

const steps = (ground: Ground): CueDef => ({
  files: [1, 2, 3, 4].map((n) => `step-${ground}-${n}.mp3`),
  gain: 0.28,
  jitter: 0.06,
  window: 0.12,
  world: true
})

export const BANK = {
  // Interface
  click: { files: ['ui-click.mp3'], gain: 0.35, jitter: 0.04 },
  confirm: { files: ['ui-confirm.mp3'], gain: 0.45, window: 0.2 },
  /** Not now: no mana, can't place it here, out of reach. */
  fizzle: { files: ['ui-refuse.mp3'], gain: 0.4, window: 0.2 },
  notice: { files: ['ui-notice.mp3'], gain: 0.35, window: 0.4, yields: true },
  glim: { files: ['coins.mp3'], gain: 0.45, jitter: 0.05, window: 0.15 },
  discover: { files: ['discover.mp3'], gain: 0.4, window: 0.3 },
  blip: { synth: 'blip', gain: 1, jitter: 0.03 },
  voice: { synth: 'voice', gain: 1, jitter: 0.06, window: 0.055 },
  quest: { synth: 'quest', gain: 1, window: 1 },
  'step-area': { synth: 'step-area', gain: 1, window: 0.5 },
  lantern: { synth: 'lantern', gain: 1, window: 1 },

  // Work and the world
  'step-grass': steps('grass'),
  'step-path': steps('path'),
  'step-stone': steps('stone'),
  'step-wood': steps('wood'),
  chop: { files: ['chop-1.mp3', 'chop-2.mp3'], gain: 0.6, jitter: 0.05, world: true },
  quarry: { files: ['quarry-1.mp3', 'quarry-2.mp3'], gain: 0.55, jitter: 0.05, world: true },
  dig: { files: ['dig.mp3'], gain: 0.55, jitter: 0.06, world: true },
  plant: { files: ['plant.mp3'], gain: 0.5, jitter: 0.06, window: 0.15 },
  craft: { files: ['craft.mp3'], gain: 0.5, jitter: 0.03, window: 0.2 },
  pickup: { files: ['pickup.mp3'], gain: 0.5, jitter: 0.06, window: 0.1 },
  'door-open': { files: ['door-open.mp3'], gain: 0.4, window: 0.5, world: true },
  'door-close': { files: ['door-close.mp3'], gain: 0.4, window: 0.5, world: true },
  pop: { synth: 'pop', gain: 1, jitter: 0.03 },
  /** Fishing (crafts.md 5.5): the line going out, the float's dip, the fish landing. */
  'fish-cast': { files: ['swing-1.mp3', 'swing-2.mp3'], gain: 0.22, jitter: 0.1, window: 0.3, world: true },
  'fish-bite': { synth: 'pop', gain: 0.7, jitter: 0.05, window: 0.5, world: true },
  'fish-splash': { files: ['roll.mp3'], gain: 0.3, jitter: 0.08, window: 0.3, world: true },
  settle: { synth: 'settle', gain: 1, window: 1, world: true },

  // Combat
  swing: { files: ['swing-1.mp3', 'swing-2.mp3'], gain: 0.35, jitter: 0.08, world: true },
  hit: { files: ['hit-1.mp3', 'hit-2.mp3'], gain: 0.55, jitter: 0.06, cap: 2, window: 0.05, world: true },
  crit: { files: ['crit.mp3'], gain: 0.65, jitter: 0.04, world: true },
  hurt: { files: ['hurt.mp3'], gain: 0.6, jitter: 0.05, window: 0.2, world: true },
  roll: { files: ['roll.mp3'], gain: 0.45, jitter: 0.06, window: 0.2, world: true },
  /** A creature calmed (enemies are settled, never killed). */
  calm: { files: ['calm.mp3'], gain: 0.4, jitter: 0.03, window: 0.15, world: true },
  /** A blow ringing off stone that isn't fighting back (the warden's shell). */
  clink: { files: ['clink.mp3'], gain: 0.45, jitter: 0.06, world: true },
  cast: { synth: 'cast', gain: 1, jitter: 0.02, world: true },
  windup: { synth: 'windup', gain: 1, window: 0.1, world: true },
  falter: { synth: 'falter', gain: 1, window: 0.5, world: true },
  defeat: { synth: 'defeat', gain: 1, window: 1 }
} satisfies Record<string, CueDef>

export type SoundCue = keyof typeof BANK

/**
 * Ambience loops by area id (played softly under everything, crossfaded on
 * area change). Empty: Kenney has no fitting ambience; CC0 loops (Freesound)
 * can be dropped in here later.
 */
export const AMBIENCE: Record<string, string> = {}

/** Every sample file, for loading once. */
export function sampleFiles(): string[] {
  const all = new Set<string>()
  for (const def of Object.values(BANK) as CueDef[]) for (const f of def.files ?? []) all.add(f)
  return [...all]
}
