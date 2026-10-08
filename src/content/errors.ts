/**
 * What players are told when something they asked for doesn't happen: a
 * server refusal (its code from src/lib/api/errors.ts) or one of the
 * client's own outcomes for a write (src/game/link.ts). Static text only;
 * nothing a server sends is ever shown.
 *
 * Each domain has its own table, because the same code means a different
 * thing there and is said differently on purpose. `tier-required` is "your
 * own workshop bench" for an item, "the workshop" in the village and "the
 * cottage" on your land; `not-a-member` is the bench again for an item and
 * the deed elsewhere; `insufficient-materials` is about mending an item and
 * about building or crafting elsewhere. Codes a table doesn't name get its
 * transport line, then its fallback.
 */
import { GATHERING_DATA } from '../lib/gathering.ts'
import { MAIL } from '../lib/mail.ts'

type Table = Readonly<Record<string, string>>

/** The write didn't happen, or hasn't yet, for reasons that aren't the domain's: said the same way everywhere. */
export const TRANSPORT_ERRORS: Table = {
  offline: 'Needs a connection. Nothing changed — try again when you’re back online.',
  superseded: 'Another device took over this journey.',
  busy: 'Hold on — the last one is still on its way.'
}

/** A lost answer, replayed (items and the village; Silas says it his own way). */
const REPLAYED: Table = {
  resolved: 'Your last request went through after all. Check what you have before trying again.',
  pending: 'No answer yet — it may have gone through. We’ll find out when the connection is back; nothing will be taken twice.'
}

const FALLBACK = 'That didn’t go through. Nothing changed — try again in a moment.'

/** Item refusals (src/game/items.ts). */
export const ITEM_ERRORS: Table = {
  ...REPLAYED,
  'tool-blunt': 'It’s too blunt to work with. Mend it first.',
  'two-wardens-grind': 'Two slivers in one pack pull toward each other’s pose and grind.',
  'gathered-enough': GATHERING_DATA.softCapLine,
  'cannot-gather-here': 'There’s nothing there to work.',
  'cannot-plant-here': 'Plant it on your own land.',
  'not-your-land': 'That’s someone else’s land. Leave it as you found it.',
  'land-blocked': 'There’s no open ground to plant in here.',
  'not-a-seed': 'That isn’t something you can plant.',
  'wrong-tool': 'That isn’t the tool for this.',
  'not-a-tool': 'That isn’t a tool.',
  'not-needed': 'No need just now.',
  'too-weak': 'You’re too far gone to eat. Rest by a hearth first.',
  'not-usable-yet': 'Keep it for when you need it.',
  'cannot-mend': 'Bench tools aren’t worth mending. Make another.',
  'too-far-away': 'You need to be right there.',
  'not-a-member': 'That needs your own workshop bench.',
  'tier-required': 'That needs your own workshop bench.',
  'no-free-slot': 'There’s no room on it for another fitting.',
  'fitting-kind-taken': 'It already has one of those.',
  'already-fitted': 'That’s already on it.',
  'not-fitted': 'That isn’t fitted to anything.',
  'not-together': 'Stand next to them to hand it over.',
  'not-giveable': 'That one stays with you.',
  'well-rope-broken': 'The well rope is rotten through. Mend it first.',
  'already-returned': 'You have already returned that.',
  'wrong-recipient': 'That doesn’t belong to them.',
  'self-gift': 'You can’t give something to yourself.',
  'recipient-not-found': 'They aren’t in your world just now.',
  'world-access-denied': 'They aren’t in your world just now.',
  'recipient-unavailable': 'They aren’t in your world just now.',
  'no-such-pocket': 'A satchel, apron or coat gives you a second pocket.',
  'not-a-keepsake': 'Pockets are for keepsakes.',
  'off-hand-closed': 'Your off hand opens when you take a class.',
  'not-for-the-off-hand': 'That isn’t something to carry in your off hand.',
  'already-picked-up': 'You’ve already picked that up.',
  'invalid-region': 'The woods have shifted under you. Step back a moment.',
  'not-in-season': 'Not now — that belongs to another season. Come back when it turns.',
  'sold-out': 'That’s all they had today. Come back tomorrow.',
  'invalid-seller': 'There’s nothing like that to buy here.',
  'invalid-good': 'There’s nothing like that to buy here.',
  'condition-unmet': 'You aren’t ready for that yet.',
  'already-granted': 'You’ve already received that heirloom.',
  'insufficient-items': 'You don’t have that any more.',
  'insufficient-materials': 'You don’t have enough to mend it.',
  'insufficient-embers': 'You don’t have enough embers.',
  'item-not-available': 'That isn’t in your pack any more.',
  'item-not-found': 'That isn’t in your pack any more.'
}

/** Village refusals: the chests, the bench, mail, projects, chores, the shelf, the desk and the woodpile (src/game/village.ts). */
export const VILLAGE_ERRORS: Table = {
  ...REPLAYED,
  'tier-required': 'That needs the workshop. Silas can build it on.',
  'insufficient-materials': 'You don’t have enough materials for that.',
  'insufficient-items': 'You don’t have that many to move. Anything set out has to be put away first.',
  'insufficient-storage': 'The chest doesn’t hold that many.',
  'chest-full': 'Your own chest is full. It’s a small one.',
  'not-a-member': 'That’s for the folk on this deed.',
  'already-taken-today': 'One gift from this shelf each day. Walk by again tomorrow.',
  'slot-occupied': 'Something is already in that slot.',
  'slot-empty': 'That slot is empty.',
  'shelf-not-placed': 'There is no gift shelf set out at this gate.',
  'shelf-not-empty': 'Clear the gifts from the shelf before putting it away.',
  'homestead-desolate': 'The old deed has gone quiet.',
  'homestead-not-found': 'There is no deed behind that gate.',
  'cannot-recall-thanks': 'A thank-you cannot be called back.',
  'asset-required': 'Choose something to leave on the shelf.',
  'gate-required': 'Choose a gate first.',
  'invalid-slot': 'That shelf slot is out of reach.',
  'invalid-operation': 'That is not something the shelf can do.',
  'not-giveable': 'That one stays with you.',
  'item-not-available': 'That piece isn’t free to move just now.',
  'two-wardens-grind': 'Two slivers in one pack pull toward each other’s pose and grind.',
  'invalid-quantity': 'That’s not an amount Silas would write down.',
  'self-mail': 'You can’t post something to yourself.',
  'recipient-not-found': 'They aren’t in your world any more.',
  'world-access-denied': 'They aren’t in your world any more.',
  'mail-not-found': 'That parcel isn’t yours to open.',
  'mail-access-denied': 'That parcel isn’t yours to open.',
  'already-claimed': 'That parcel has already been collected.',
  'already-returned': 'That parcel has already gone back to its sender.',
  'recipient-unavailable': 'They can’t take parcels just now: they’re not admitted to your world.',
  'mail-sender-limit': `You have ${MAIL.maxOutstandingSent} parcels waiting to be collected already. Wait for some to be collected, or recall one.`,
  'mail-recipient-limit': 'Their mailbox is full. They need to collect some parcels first.',
  'mail-rate-limited': 'The post rider needs a moment. Try again in a minute.',
  'project-complete': 'That project is finished. Thank you!',
  'project-overfilled': 'That’s more than the project still needs. Give a little less.',
  'invalid-contribution': 'That project doesn’t take that material.',
  'project-not-found': 'Mara can’t find that project in the ledger.',
  'repair-not-found': 'There’s no such chore on the board.',
  'repair-not-open': 'That chore isn’t open in this world yet.',
  'already-mended': 'It’s mended already. Someone got there first.',
  'invalid-recipe': 'That isn’t a recipe anyone keeps here.',
  'recipe-unknown': 'You never learned that recipe. Its page teaches it, once you find it.',
  'craft-only': 'Silas doesn’t sell that piece. It’s made at the bench, or given.',
  'desk-required': 'That needs a writing desk set out at home.',
  'woodpile-required': 'That needs a woodpile set out at home.',
  'invalid-page': 'That isn’t a page the desk can copy.',
  'page-not-held': 'You don’t hold that page. The desk copies pages you carry.',
  'nothing-ready': 'Nothing on the pile has seasoned yet. Green wood takes a real day.',
  'invalid-action': 'That’s not something a woodpile does.'
}

/** Homestead refusals, mostly Silas's (src/game/homestead.ts). */
export const HOME_ERRORS: Table = {
  'tier-required': 'That needs the cottage first. Silas can raise it for you.',
  'tier-unavailable': 'Silas isn’t building that yet.',
  'placement-overlap': 'Something’s already there.',
  'out-of-bounds': 'That’s past the edge of your land.',
  'invalid-placement': 'That one doesn’t belong there.',
  'land-blocked': 'A tree or a rock is in the way. Build around it, or have Silas clear it.',
  'plant-in-the-way': 'Something’s growing there.',
  unlit: 'That ground is past your lamplight. Set a lantern post nearer to hold it.',
  'post-holds-land': 'That lamp is holding up ground you’ve built on. Move those pieces first.',
  'name-required': 'A lamp needs a name before it holds anything.',
  'not-clearable': 'There’s nothing there for Silas to clear.',
  'insufficient-embers': 'Not enough embers for that.',
  'insufficient-materials': 'You’re short on materials for that.',
  'already-placed': 'That’s already set out.',
  'shelf-not-empty': 'Take the gifts off your shelf before putting it away.',
  'not-placed': 'That’s already put away.',
  'item-not-owned': 'That isn’t yours to move.',
  'not-a-member': 'That’s for the folk on this deed.',
  'already-homesteaded': 'One place on the Commons each. You’d have to give up your deed first.',
  'gate-taken': 'Someone has that deed already.',
  'not-at-table': 'Silas signs deeds at his table. Stand by it.',
  'partner-not-at-table': 'Both names go on at once. Your partner needs to be at the table too.',
  'invite-not-found': 'That offer has lapsed. Ask again.',
  'chest-full': 'Your own chest is full.',
  resolved: 'Your last order with Silas went through after all. Check what you have before trying again.',
  pending: 'No answer yet — it may have gone through. We’ll find out when the connection is back; nothing will be charged twice.'
}

/**
 * An ember spend that didn't happen, so nothing was spent: a lantern, the
 * chest, a rest (src/game/scenes/world-actions.ts). `syncing` is a guest's
 * spend while a Habitica sync owns the save.
 */
export const SPEND_ERRORS: Table = {
  short: 'The flame gutters — not enough embers after all.',
  full: 'You’re already rested. Keep your embers.',
  done: 'That’s already done.',
  'needs-earned': 'Only embers earned on Habitica can get you back on your feet.',
  unsafe: 'Resting only works in Hearthwick.',
  'not-home': 'You can only rest at your own place.',
  syncing: 'Hold on — your hero is still syncing. Try again in a moment.',
  offline: 'Needs a connection. Your embers are safe — try again when you’re back online.'
}

/** The words for `code` from a domain's table, then the shared transport lines, then `fallback`. */
export function errorText(table: Table, code: string, fallback = FALLBACK): string {
  return (Object.hasOwn(table, code) ? table[code] : undefined) ?? (Object.hasOwn(TRANSPORT_ERRORS, code) ? TRANSPORT_ERRORS[code] : undefined) ?? fallback
}

export const itemErrorText = (code: string): string => errorText(ITEM_ERRORS, code)
export const villageErrorText = (code: string): string => errorText(VILLAGE_ERRORS, code)
export const homeErrorText = (code: string): string => errorText(HOME_ERRORS, code, 'Silas didn’t catch that. Nothing changed — try again in a moment.')
export const spendErrorText = (code: string): string => errorText(SPEND_ERRORS, code, 'The lantern didn’t answer. Nothing was spent — try again in a moment.')
