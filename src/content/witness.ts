/**
 * Witnessing (docs/home-server.md "Witnessing"): standing near another
 * player in the same place when their story reaches one of its shared beats.
 * The server relays the moment from its own record of the beat; the
 * witness's story doesn't move. What stays is a journal line, "you were
 * there", once per beat and traveler: a story flag, never a reward.
 *
 * Canon voice, every line at most 160 characters (tests/witness.test.ts).
 * Echo lines never name whose Echo it was: that is the settler's to learn
 * (src/content/echoes.ts, "shown once settled, never before").
 */
import type { JournalEntry } from './world.ts';

/** The beats the server relays: the Warden's naming, the last lantern, an Echo settled. */
export type WitnessBeat = 'warden' | 'lantern' | `echo:${string}`;

const ECHO_MEMBERS = ['hollis', 'tam', 'bett', 'dorrit', 'joss', 'nan'];

/** A beat id the server may send (anything else is ignored). */
export function isWitnessBeat(beat: unknown): beat is WitnessBeat {
  if (beat === 'warden' || beat === 'lantern') return true;
  return typeof beat === 'string' && beat.startsWith('echo:') && ECHO_MEMBERS.includes(beat.slice(5));
}

/** A traveler's name as a line can carry it. */
export function witnessName(name: unknown): string {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return s || 'A fellow traveler';
}

const kind = (beat: WitnessBeat): 'warden' | 'lantern' | 'echo' => (beat === 'warden' || beat === 'lantern' ? beat : 'echo');

/** The flag key for a beat ("echo:nan" keeps no colon inside: "echo-nan"). */
const beatKey = (beat: WitnessBeat): string => beat.replace(':', '-');

/** Every witness flag for this beat and traveler starts so (the name follows). */
export function witnessFlagPrefix(beat: WitnessBeat, doerId: string): string {
  return `witness:${beatKey(beat)}:${doerId}:`;
}

/** The story flag a witness keeps: `witness:<beat>:<their id>:<their name>`. */
export function witnessFlag(beat: WitnessBeat, doerId: string, name: string): string {
  return witnessFlagPrefix(beat, doerId) + witnessName(name);
}

/** Already witnessed (the once-per-beat-and-traveler rule). */
export function hasWitnessed(flags: readonly string[], beat: WitnessBeat, doerId: string): boolean {
  const prefix = witnessFlagPrefix(beat, doerId);
  return flags.some((f) => f.startsWith(prefix));
}

export const witnessCopy = {
  /** On screen as it happens (a toast). */
  moment: {
    warden: (name: string) => `${witnessName(name)} speaks the naming. The warden’s arms come down, its heart-lamp guttering low. You were there.`,
    lantern: (name: string) => `${witnessName(name)} lights the hilltop lantern, and the old road runs bright toward the village. You were there.`,
    echo: (name: string) => `${witnessName(name)} lights an owed lamp, and a waiting moment finishes kindly and goes quiet. You were there.`,
  },
  /** Your own warden, still waiting: it rested, then the stone remembered its pose. */
  wardenRises: 'The stone remembers its pose. Here on your road the warden lifts its arms again, still waiting for your own naming.',
  /** Floated over the warden as it rises. */
  wardenFloat: 'it remembers its pose',
  /** The journal's "you were there" lines. */
  journalTitle: 'You Were There',
  journal: {
    warden: (name: string) => `I stood on the shrine path while ${witnessName(name)} spoke the naming. The warden rested in its pose. Mine still waits for me.`,
    lantern: (name: string) => `I was on the hill when ${witnessName(name)} lit the last lantern. The light ran down the road like someone calling everyone home.`,
    echo: (name: string) => `In the Whitequiet I watched ${witnessName(name)} light an owed lamp. The camp’s moment finished, and the woods filed it away.`,
  },
};

/** The moment's line for a beat. */
export function witnessMoment(beat: WitnessBeat, name: string): string {
  return witnessCopy.moment[kind(beat)](name);
}

/** Journal entries for beats witnessed (the `witness:` flags), in the order they were kept. */
export function witnessJournalEntries(flags: readonly string[]): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const f of flags) {
    const m = /^witness:(warden|lantern|echo-[a-z]+):[^:]+:(.*)$/.exec(f);
    if (!m) continue;
    const k = m[1] === 'warden' || m[1] === 'lantern' ? m[1] : 'echo';
    const body = witnessCopy.journal[k](m[2]);
    // Two travelers of one name at one beat read the same: one line is enough.
    if (!out.some((e) => e.body === body)) out.push({ title: witnessCopy.journalTitle, body });
  }
  return out;
}
