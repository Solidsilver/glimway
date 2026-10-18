/**
 * The words of lamps, camps and Pell's crate (roadmap 0.13; lamps.md 2.5,
 * 2.7): the way-lamp's readout and choices, the oil, the keeper's rules,
 * packing up, and Pell's crate. The rules that pick a line live in
 * src/lib/camps.ts; the words are here, for the lore pass.
 */
import type { CampRule } from '../lib/camps.ts'

/** "a, b and c". */
export function listed(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

const wicks = (n: number) => `${n} ${n === 1 ? 'wick' : 'wicks'}`

/** Hearth oil, as both a way-lamp and a lot lantern take it. */
export const LAMP_OIL = {
  topUp: 'Top it up with hearth oil',
  fill: 'Fill it with hearth oil',
  /** Under the choice when you carry none: both ways to come by it (wick sap since decisions #39, #43). */
  needOil: 'You need hearth oil: the chandler sells it, or tap the Wick Tree’s sap each week.',
  /** A lamp at its cap, from content (homestead.json maxWicks): "The lamp", "The lantern". */
  full: (what: string, max: number) => `${what}’s full. It takes ${wicks(max)} of oil at most.`,
} as const

/** The way-lamp's own words: its readout, its choices and what it says when done. */
export const CAMP_WORDS = {
  yours: 'Your way-lamp.',
  whose: (name: string) => `${name || 'Someone'}’s way-lamp.`,
  oil: (oil: number, max: number) => `${oil} of ${max} ${max === 1 ? 'wick' : 'wicks'} of oil`,
  guttering: (whose: string, oil: string) => `${whose} It’s guttering: ${oil}. Unless it’s filled, it goes dark at the turning and the camp turns with it. Everything set out here would wait at Pell’s.`,
  lastWick: (whose: string) => `${whose} It’s dimming: the oil’s gone, and it’s on its last wick. Fill it to keep this camp; left empty, it gutters for a wick after the turning, then goes dark.`,
  burning: (whose: string, oil: string) => `${whose} It burns, ${oil} left. The woods it lights hold while it does.`,
  lampName: 'Way-lamp',
  look: (name: string) => name ? `Look at ${name}` : 'Look at the way-lamp',
  pickUp: (piece: string) => `Pick up the ${piece.toLowerCase()}`,
  moveOff: (owner: string, piece: string) => `Move ${owner}’s ${piece.toLowerCase()} off`,
  takeDown: { text: 'Take the lamp down', note: 'The camp goes; its oil comes back to you' },
  leave: 'Leave it',
  neverMind: 'Never mind',
  sendToPell: 'Send it to Pell’s',
  /** Toasts once the server says it's done. */
  takenDown: 'You take the way-lamp down. Its oil is back in your pack.',
  lit: 'The way-lamp is lit. The woods in its light hold through the turning while it has oil.',
  planted: 'Planted, in the lamp’s light.',
  setOut: 'Set out at the camp.',
} as const

/** Asked before the keeper moves someone's piece off: it goes to Pell's, still theirs. */
export const MOVE_OFF_WORDS = {
  ask: (owner: string, piece: string) => `Move ${owner}’s ${piece.toLowerCase()} off your camp? Pell keeps it in a crate for ${owner}. Nothing is lost.`,
  done: (owner: string, piece: string) => `${owner}’s ${piece.toLowerCase()} is waiting at Pell’s for ${owner}.`,
} as const

/** The refusal when you may not build at someone's camp: whose it is, and what you can still do. */
export const CAMP_REFUSAL = {
  named: (who: string) => `This is ${who}’s camp, and ${who} says who builds here. You’re welcome to walk through and tend the lamp.`,
  unnamed: 'This camp’s keeper says who builds here. You’re welcome to walk through and tend the lamp.',
} as const

/** A plant at a camp: whose it is, and (to whoever may) that a trowel digs it up. */
export const CAMP_PLANT_WORDS = {
  theirs: (owner: string, plant: string) => `${owner}’s ${plant.toLowerCase()}, growing in the lamp’s light.`,
  yours: (plant: string) => `Your ${plant.toLowerCase()}, growing in the lamp’s light.`,
  mayDig: 'A trowel would dig it up.',
} as const

/** A camp plant's look: its only choice is to leave it (digging up is the trowel's). */
export const CAMP_PLANT_CHOICES = [{ text: 'Leave it', dismiss: true }] as const

/** The keeper's "pack up the camp": everything to Pell's at once, as at a lapse. */
export const CAMP_PACK_WORDS = {
  pack: { text: 'Pack up the camp', note: 'Everything here goes to Pell’s' },
  ask: [
    'Pack up the whole camp?',
    'Pell keeps every piece and plant in a crate for whoever it belongs to. The lamp and its oil wait there for you. Nothing is lost.',
    'Any path laid here comes back at the turning.'
  ],
  confirm: 'Pack it all up',
  keep: 'Leave it standing',
  done: 'The camp’s packed up. Everything waits at Pell’s.'
} as const

/** The panel's words: its heading, and each rule as a choice and as a sentence (lib/camps.ts CampRule). */
export const CAMP_RULE_WORDS = {
  heading: 'Who may build here',
  rules: {
    household: { pick: 'Just my household', line: 'You and your household build here.' },
    listed: { pick: 'My household and people I name', line: 'You, your household and the people you name build here.' },
    except: { pick: 'Everyone but people I name', line: 'Everyone in the world builds here, except the people you name.' },
    everyone: { pick: 'Everyone in the world', line: 'Everyone in the world builds here.' }
  } satisfies Record<CampRule, { pick: string; line: string }>,
  now: 'As it is',
  name: 'Name someone',
  noneToName: 'Everyone’s on the list already',
  unname: (name: string) => `Take ${name} off the list`,
  named: (names: string[]) => `Named: ${listed(names)}.`,
  noneNamed: 'No one named yet.',
  open: 'Anyone may still walk here and add oil.',
  pickWho: 'Who goes on the list?',
  done: 'Done'
} as const

/** A camp refusal in words: the lot lantern's shared codes, said of a way-lamp ('lantern-full' is LAMP_OIL.full, from content). */
export const CAMP_ERRORS: Record<string, string> = {
  'cannot-hold': 'A way-lamp can’t hold this ground: it’s the town, the Tangle, a lot’s backland or someone else’s camp.',
  'too-far-away': 'Stand closer to the way-lamp.',
  'not-in-world': 'You can only name people who live in this world.'
}

// ------------------------------------------------------------ Pell's crate (lamps.md 2.7; decision #45's draft lines)

/** Pell's words for a crate waiting, by why each entry is there (lib/camps.ts RECOVERY_REASONS; '' is a lapse). */
export const CRATE_LINES = {
  lapsed: 'The woods turned. I have your things.',
  lapsedTail: 'Nothing’s missing. I counted.',
  inCrate: (things: string, tail: string) => `In the crate: ${things}. ${tail}`,
  /** Each reason: Pell's opening line, then the tail after the list. */
  reasons: {
    'land-changed': ['The land changed out past the Commons, and your old paths went with it. What you paid for them didn’t.', 'Every tile you laid, counted.'],
    'deed-lost': ['Your lot went back to the deeds book. Before it did, I packed up everything on it.', 'Yours whenever you want it.'],
    'packed-up': ['You packed up your camp. It’s all here, every piece of it.', 'All of it, as you left it.'],
  } as Record<string, readonly [string, string]>,
  movedOff: (keeper: string, things: string) => `Moved off ${keeper}’s camp: ${things}. I kept it safe for you.`,
  collected: (things: string) => `Signed out to you: ${things}. The home pieces are in your pack.`,
  /** The note under an entry in the picker. */
  notes: {
    movedOff: (keeper: string) => `Moved off ${keeper}’s camp`,
    'land-changed': 'Your old paths, paid back',
    'deed-lost': 'From your old lot',
    'packed-up': 'From the camp you packed up',
    lapsed: 'From a camp the woods took back',
  },
} as const

/** The picker's words. */
export const CRATE_WORDS = {
  title: 'Pell’s crate',
  close: 'Close the crate',
  lede: 'Everything here is yours, kept as you left it. Take what you want now. The rest waits here as long as you like.',
  loading: 'Pell’s opening the book…',
  empty: 'Nothing waiting for you. The book’s square.',
  takeAll: 'Take everything',
  take: 'Take',
  takeWhole: 'Take it whole',
  takeSeed: 'Take its seed',
  taking: 'Taking…',
  plantNote: 'Whole, it keeps its growth and goes back in the ground wherever you can plant. As a seed, it starts over.',
  /** Pell's choices at the desk: everything at once, or the picker. */
  takeYours: 'Take your things from the crate',
  choose: 'Choose what to take',
  chooseNote: 'Leave the rest with Pell'
} as const
