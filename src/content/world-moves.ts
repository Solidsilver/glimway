/**
 * Copy for party worlds and moving between worlds
 * (docs/expansion-design.md "Worlds"). Canon voice, every line at most 160
 * characters (tests/world-moves.test.ts).
 */
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)
/** An owner's name, or a stand-in when the server has none. */
const who = (owner: string): string => String(owner ?? '').trim() || 'a fellow traveler'
/** "Olive’s world" (sentence-initial forms capitalise the stand-in). */
const worldOf = (owner: string): string => `${who(owner)}’s world`
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
/** What the copy needs to name a world (a WorldRef). */
type Named = { ownerName: string; party: boolean }
/** "Olive’s world", "your party’s world", or (not yours) "another party’s world". */
const place = (w: Named, myParty = true): string =>
  w?.party ? (myParty ? 'your party’s world' : 'another party’s world') : worldOf(w?.ownerName)

export const worldCopy = {
  place,
  /** The same, starting a label. */
  name: (w: Named, myParty = true) => cap(place(w, myParty)),
  // The one-time prompt.
  prompt: (members: number) => (members > 0 ? 'Your party has a world of its own here. Join them?' : 'Your party has a world of its own here, its lamps not yet lit. Go first?'),
  promptNote: 'You can find this again under Your world in the Menu.',
  join: (members: number) => (members > 0 ? 'Join them…' : 'Go first…'),
  later: 'Not now',
  // The Menu's "Your world" card.
  livesIn: (where: string, mine: boolean) => (mine ? 'You live in your own world.' : `You live in ${where}.`),
  /** Your own world, where you live. */
  members: (n: number) => (n <= 1 ? 'Just you so far.' : `${n} travelers call it home.`),
  /** Someone else's world (or yours, from afar): who lives there now. */
  travelers: (n: number, owner: string, ownerHere: boolean) =>
    n <= 0 ? 'No one lives there just now.' : n === 1 && ownerHere ? `Just ${who(owner)} so far.` : n === 1 ? 'One traveler calls it home.' : `${n} travelers call it home.`,
  partyHome: 'It belongs to your party, not to any one of you. Party members come straight in, no code needed.',
  partyThere: 'Your party has a world of its own here.',
  partyMissing: 'Your party has no world here yet. Open one, and party members can come straight in.',
  partyOpen: 'Open it',
  partyOpenFailed: 'That didn’t take. Try again in a moment.',
  readFailed: 'Couldn’t read your world just now. Try again in a moment.',
  ownThere: 'Your own world still keeps its lamps lit, if you’d like to go back.',
  goHome: 'Go back…',
  // The move screen.
  eyebrow: 'Moving worlds',
  title: (where: string) => `Move to ${where}?`,
  titleHome: 'Go back to your own world?',
  lead: 'Everything you carry comes along. What you built stays where it stands.',
  comes: 'Comes with you',
  stays: 'Stays behind',
  comeHero: 'Your hero and your story so far',
  comeEmbers: (n: number) => `Your embers (${n})`,
  comePack: 'Everything in your pack',
  comeChest: 'Your personal chest',
  stayHome: (lot: number) => `Your name on the deed at lot ${lot}`,
  stayHomeLast: 'No one else holds that deed, so the land will slowly go quiet.',
  stayNoHome: 'No homestead to leave behind.',
  stayGoods: 'Placed furniture, the shared chest and the gate shelf',
  stayWilds: 'Your claims in the Wilds',
  stayProjects: 'Village project gifts, still credited there',
  incoming: (n: number) => `${n} ${plural(n, 'parcel', 'parcels')} waiting for you will go back to ${plural(n, 'its sender', 'their senders')}.`,
  wardenTools: (n: number) =>
    `${n} warden-set ${plural(n, 'tool rests', 'tools rest')} in the shared chest. Take ${plural(n, 'it', 'them')} first, or ${plural(n, 'it stays', 'they stay')} behind.`,
  deedCost: (n: number) => `A deed there costs ${n} embers from Silas: only your first was free.`,
  blockArea: 'Walk to the village or the Commons first.',
  blockMail: (n: number) => `${n} ${plural(n, 'parcel you sent is', 'parcels you sent are')} still on the road. Recall ${plural(n, 'it', 'them')} at a mailbox first.`,
  blockOffline: 'Moving needs a connection.',
  blockPending: 'An earlier errand is still settling. Try again in a moment.',
  blockCooldown: (when: string) => `Travelers rest a day between worlds. The road opens again ${when}.`,
  /** How long until the road opens again, from seconds left. */
  opensIn: (seconds: number) => {
    const s = Number(seconds)
    if (!Number.isFinite(s) || s <= 90) return 'in a minute or so'
    const m = Math.round(s / 60)
    if (m < 55) return `in about ${m} minutes`
    const h = Math.round(s / 3600)
    return h <= 1 ? 'in about an hour' : `in about ${h} hours`
  },
  confirm: (where: string) => `Move to ${where}`,
  confirmHome: 'Go back home',
  cancel: 'Stay here',
  working: 'Packing up…',
  arriving: 'Arriving…',
  again: 'Moving back works the same way, a day from now at the soonest. Old homes aren’t kept for you.',
  done: (where: string) => `You set down your pack in ${where}.`,
  doneHome: 'You’re back in your own world. The lamps remember you.',
  landed: 'Your move went through. You set down your pack in a new world.',
  replayRefused: 'Your earlier move didn’t go through. You’re still where you were.',
  arriveFailed: 'Your move went through, but the new world didn’t open here. Continue to step in.',
  failed: 'That didn’t go through. Nothing moved, so try again.',
  denied: 'That world isn’t open to you any more.',
  offline: 'Your world needs a connection for this.'
}
