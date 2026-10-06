/**
 * Copy for party-linked worlds and moving between worlds
 * (docs/expansion-design.md "Worlds"). Canon voice, every line at most 160
 * characters (tests/world-moves.test.ts).
 */
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)
/** An owner's name, or a stand-in when the server has none. */
const who = (owner: string): string => String(owner ?? '').trim() || 'a fellow traveler'
/** "Olive’s world" (sentence-initial forms capitalise the stand-in). */
const worldOf = (owner: string): string => `${who(owner)}’s world`
const WorldOf = (owner: string): string => {
  const w = worldOf(owner)
  return w.charAt(0).toUpperCase() + w.slice(1)
}

export const worldCopy = {
  worldOf: WorldOf,
  // The one-time prompt.
  prompt: (owner: string) => `Your party plays in ${worldOf(owner)}. Join them?`,
  promptNote: 'You can find this again under Your world in the Menu.',
  join: 'Join them…',
  later: 'Not now',
  // The Menu's "Your world" card.
  livesIn: (owner: string, mine: boolean) => (mine ? 'You live in your own world.' : `You live in ${worldOf(owner)}.`),
  /** Your own world, where you live. */
  members: (n: number) => (n <= 1 ? 'Just you so far.' : `${n} travelers call it home.`),
  /** Someone else's world (or yours, from afar): who lives there now. */
  travelers: (n: number, owner: string, ownerHere: boolean) =>
    n <= 0 ? 'No one lives there just now.' : n === 1 && ownerHere ? `Just ${who(owner)} so far.` : n === 1 ? 'One traveler calls it home.' : `${n} travelers call it home.`,
  linkTitle: 'Party link',
  linkedMine: 'Linked to your party: party members arriving for the first time settle here.',
  linkedElsewhere: (owner: string) => `Linked to your party, but newcomers settle in ${worldOf(owner)}.`,
  linkedOther: 'Linked to another party. Link it to yours to welcome your own.',
  unlinked: 'Not linked. Newcomers from your party start worlds of their own.',
  unlinkedElsewhere: (owner: string) => `Not linked. Newcomers from your party settle in ${worldOf(owner)}.`,
  linkHere: 'Link here instead',
  link: 'Link to my party',
  unlink: 'Unlink',
  noParty: 'When your party gathers, you can link this world to it.',
  linkFailed: 'That didn’t take. Try again in a moment.',
  readFailed: 'Couldn’t read your world just now. Try again in a moment.',
  partyThere: (owner: string) => `Your party plays in ${worldOf(owner)}.`,
  ownThere: 'Your own world still keeps its lamps lit, if you’d like to go back.',
  ownLinked: 'It’s still linked to your party.',
  goHome: 'Go back…',
  ownerOnly: 'Only the world’s owner can change its party link.',
  // The move screen.
  eyebrow: 'Moving worlds',
  title: (owner: string) => `Move to ${worldOf(owner)}?`,
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
  confirm: (owner: string) => `Move to ${worldOf(owner)}`,
  confirmHome: 'Go back home',
  cancel: 'Stay here',
  working: 'Packing up…',
  arriving: 'Arriving…',
  again: 'Moving back later works the same way. Old homes aren’t kept for you.',
  done: (owner: string) => `You set down your pack in ${worldOf(owner)}.`,
  doneHome: 'You’re back in your own world. The lamps remember you.',
  landed: 'Your move went through. You set down your pack in a new world.',
  replayRefused: 'Your earlier move didn’t go through. You’re still where you were.',
  arriveFailed: 'Your move went through, but the new world didn’t open here. Continue to step in.',
  failed: 'That didn’t go through. Nothing moved, so try again.',
  denied: 'That world isn’t open to you any more.',
  offline: 'Your world needs a connection for this.'
}
