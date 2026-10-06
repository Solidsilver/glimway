/**
 * Copy for party-linked worlds and moving between worlds
 * (docs/expansion-design.md "Worlds"). Canon voice, every line at most 160
 * characters (tests/world-moves.test.ts).
 */
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

export const worldCopy = {
  // The one-time prompt.
  prompt: (owner: string) => `Your party plays in ${owner}’s world. Join them?`,
  promptNote: 'You can find this again under Your world in the Menu.',
  join: 'Join them…',
  later: 'Not now',
  // The Menu's "Your world" card.
  livesIn: (owner: string, mine: boolean) => (mine ? 'You live in your own world.' : `You live in ${owner}’s world.`),
  members: (n: number) => (n <= 1 ? 'Just you so far.' : `${n} travelers call it home.`),
  /** Someone else's world, by its owner. */
  travelers: (n: number, owner: string) => (n <= 1 ? `Just ${owner} so far.` : `${n} travelers call it home.`),
  linkTitle: 'Party link',
  linkedMine: 'Linked to your party: party members who arrive for the first time settle here.',
  linkedOther: 'Linked to another party. Link it to yours to welcome your own.',
  unlinked: 'Not linked. Newcomers from your party start worlds of their own.',
  link: 'Link to my party',
  unlink: 'Unlink',
  noParty: 'Join a party to link this world to it.',
  partyThere: (owner: string) => `Your party plays in ${owner}’s world.`,
  ownThere: 'Your own world still keeps its lamps lit, if you’d like to go back.',
  goHome: 'Go back…',
  ownerOnly: 'Only the world’s owner can change its party link.',
  // The move screen.
  eyebrow: 'Moving worlds',
  title: (owner: string) => `Move to ${owner}’s world?`,
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
  blockArea: 'Walk to the village or the Commons first.',
  blockMail: (n: number) => `${n} ${plural(n, 'parcel you sent is', 'parcels you sent are')} still on the road. Recall ${plural(n, 'it', 'them')} at a mailbox first.`,
  blockOffline: 'Moving needs a connection.',
  blockPending: 'An earlier errand is still settling. Try again in a moment.',
  confirm: (owner: string) => `Move to ${owner}’s world`,
  confirmHome: 'Go back home',
  cancel: 'Stay here',
  working: 'Packing up…',
  again: 'Moving back later works the same way. Old homes aren’t kept for you.',
  done: (owner: string) => `You set down your pack in ${owner}’s world.`,
  doneHome: 'You’re back in your own world. The lamps remember you.',
  landed: 'Your move went through. You set down your pack in a new world.',
  failed: 'That didn’t go through. Nothing moved, so try again.',
  denied: 'That world isn’t open to you any more.',
  offline: 'Your world needs a connection for this.'
}
