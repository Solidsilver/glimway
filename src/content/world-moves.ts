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
  // Left the party whose world you live in.
  leaver: (when: string) => `You’ve left your party. Unless you rejoin it, you’ll be moved out of its world ${when}.`,
  leaverNote: (hasOwn: boolean) =>
    hasOwn ? 'Rejoin and sign in again to stay. Your own world still keeps its lamps lit.' : 'Rejoin and sign in again to stay. If you go, a world of your own will be waiting.',
  leaveNow: 'Leave now…',
  movedOut: 'You left your party, so you’ve been moved out of its world. You’re in a world of your own now.',
  movedOutOk: 'All right',
  /** How long until something happens, from seconds left, in round words. */
  within: (seconds: number) => {
    const s = Number(seconds)
    if (!Number.isFinite(s) || s <= 0) return 'when you next sign in'
    if (s >= 36 * 3600) return `in ${Math.round(s / 86400)} days`
    if (s <= 90) return 'in a minute or so'
    const m = Math.round(s / 60)
    if (m < 55) return `in about ${m} minutes`
    const h = Math.round(s / 3600)
    return h <= 1 ? 'in about an hour' : `in about ${h} hours`
  },
  readFailed: 'Couldn’t read your world just now. Try again in a moment.',
  ownThere: 'Your own world still keeps its lamps lit, if you’d like to go back.',
  goHome: 'Go back…',
  // The move screen.
  eyebrow: 'Moving worlds',
  title: (where: string) => `Move to ${where}?`,
  titleHome: 'Go back to your own world?',
  titleNew: 'Go to a world of your own?',
  newWorld: 'A world of your own',
  confirmLeave: 'Leave now',
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
  /** Leaving a world that is neither yours nor your party's. */
  againNoReturn: 'This world isn’t yours or your party’s. Once you leave, you can’t come back without a new invitation.',
  /** Leaving the world of a party you've left. */
  againLeaver: 'Rejoin your party and you can come back, a day from now at the soonest. Old homes aren’t kept for you.',
  /** Moving into a world no one lives in yet. */
  aloneThere: 'No one lives there yet. You’ll be the only one, and you can’t come back until tomorrow.',
  done: (where: string) => `You set down your pack in ${where}.`,
  doneHome: 'You’re back in your own world. The lamps remember you.',
  landed: 'Your move went through. You set down your pack in a new world.',
  replayRefused: 'Your earlier move didn’t go through. You’re still where you were.',
  arriveFailed: 'Your move went through, but the new world didn’t open here. Continue to step in.',
  failed: 'That didn’t go through. Nothing moved, so try again.',
  denied: 'That world isn’t open to you any more.',
  offline: 'Your world needs a connection for this.'
}

/**
 * The first sign-in's world choice (docs/home-server.md "Party worlds and
 * world moves"): a newcomer whose party has a world here, or may open one.
 * Same voice and limit as the move screen.
 */
export const firstWorldCopy = {
  eyebrow: 'Where will you live?',
  title: (name: string) => `Welcome, ${String(name ?? '').trim().slice(0, 40) || 'traveler'}. Where will you set down your pack?`,
  lead: (open: boolean) =>
    open
      ? 'Your party has no world here yet. Open one for them, or begin in a world that is yours alone.'
      : 'Your party already keeps a world here. Live in it with them, or begin in a world that is yours alone.',
  party: {
    label: (open: boolean) => (open ? 'Open your party’s world' : 'Join your party’s world'),
    /** Who lives there now (the same words as the Menu). */
    who: (n: number) => (n <= 0 ? 'No one lives there just now.' : n === 1 ? 'One traveler calls it home.' : `${n} travelers call it home.`),
    first: 'No lamps lit there yet. You’d be the first to walk its road.',
    belongs: 'It belongs to the party, not to any one of you.',
    straightIn: 'Party members come straight in, no code needed.',
  },
  own: {
    label: 'Start a world of your own',
    yours: 'Yours alone: its own road, its own lamps, its own Wilds.',
    friends: 'Invite friends with a code from the Menu.',
    /** Let in through the party: codes come from elsewhere. */
    friendsParty: 'Invite codes come from whoever keeps this server, or from a friend who was invited.',
    later: 'Your party’s world stays on offer in the Menu, if you change your mind.',
  },
  note: 'Either way you can move later from the Menu: the first move is open at once, then travelers rest a day between worlds.',
  later: 'Not now',
  working: 'Setting down your pack…',
  failed: 'That didn’t go through. Choose again in a moment.',
  partyGone: 'Your party’s world can’t be opened just now. A world of your own is still yours to start.',
  offline: 'Choosing your world needs a connection.',
  /** The title screen's Continue card while the choice waits. */
  titleGoal: 'Choose where to live.',
}
