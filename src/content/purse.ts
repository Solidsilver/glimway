/**
 * The top-up's and the glim log's words (docs/design/silas-yard.md 1.5,
 * 1.6; the 0.6 purse, purse-and-wardrobe.md 2.1, 3, with gold read as
 * glims): the Menu's glims block, the consent card ("Turn Habitica gold into
 * glims"), every top-up outcome, the Glim log, and glims at the shelf, the
 * mailbox and by hand. Plain and short: the consent card says exactly what a
 * top-up does to Habitica.
 *
 * The numbers are formatted by src/lib/purse.ts; nothing a server sends is
 * shown as text.
 */

/** "1,240" (glims and Habitica's gold read the same way everywhere). */
export const amountNumber = (n: number): string => Math.max(0, Math.floor(n)).toLocaleString('en-US')

/** "1,240 gold": Habitica's gold, which shows only as words (silas-yard.md 1.9). */
export const goldPhrase = (n: number): string => `${amountNumber(n)} gold`

/** "a glim", "12 glims" (never "glim coins", silas-yard.md 1.2). */
export const glimsPhrase = (n: number): string => (Math.floor(n) === 1 ? 'a glim' : `${amountNumber(n)} glims`)

/** "1 glim", "12 glims": a count on a button or a price, where "a glim" reads oddly. */
export const glimsCount = (n: number): string => `${amountNumber(n)} ${Math.floor(n) === 1 ? 'glim' : 'glims'}`

/** A story or quest gift of glims, as its toast says it. */
export const glimsGift = (n: number): string => `+${glimsCount(n)}. A little warmth from the road.`

export const purseCopy = {
  title: 'Glims',
  blurb: 'Glims come from the XP you earn on Habitica. You can also turn Habitica gold into glims: two gold for each, up to 30 glims a day. Glims can’t be turned back.',
  topUp: 'Turn gold into glims',
  topUpBusy: 'Syncing first…',
  log: 'Glim log',
  glimsLeft: (glims: number, topUps: number) =>
    `Today you can still get ${glimsPhrase(glims)}, in up to ${topUps === 1 ? 'one top-up' : `${topUps} top-ups`}.`,
  noTopUpsLeft: 'No more top-ups today. More after midnight UTC.',
  connectFirst: 'Connect to Habitica above first. Your details stay in this tab.',
  guest: 'Glims come from the story, and from friends: shelf sales, letters and gifts.',
  working: 'A top-up is still on its way. Its outcome shows here.',
  offline: 'Needs a connection. Top-ups wait until you’re back online.',

  // ---- the consent card (silas-yard.md 1.5)
  consentTitle: 'Turn Habitica gold into glims',
  youHave: (gold: number) => `You have ${goldPhrase(gold)} on Habitica.`,
  amountLabel: 'Glims to get',
  max: 'Max',
  maxTitle: 'Fill in the most this top-up can get. Nothing is sent until you press Get.',
  maxSendTitle: 'Fill in all your glims. Nothing is sent until you press the button.',
  rate: (glims: number | null, goldPerGlim: number) =>
    glims ? `Two gold for each glim: ${glimsCount(glims)} costs ${goldPhrase(glims * goldPerGlim)}.` : 'Two gold for each glim.',
  spends: 'This spends Habitica gold. Your Habitica balance goes down by that much, the same as buying a reward there. Glims can’t be turned back into gold.',
  how: 'Glimway adds a reward called “Glimway purse” to your Habitica Rewards for a moment, buys it, and removes it. Habitica keeps no record of this; your glim log does.',
  notNow: 'Not now',
  get: (n: number | null) => (n ? `Get ${glimsCount(n)}` : 'Get glims'),
  getting: 'Turning gold into glims…',
  checking: 'Checking with Habitica…',
  closeNote: 'You can close this. The outcome comes as a message.',
  amountHint: (max: number) => (max === 1 ? 'This top-up can get 1 glim.' : `A whole number from 1 to ${amountNumber(max)}.`),
  tooLittleGold: (goldPerGlim: number) => `You need at least ${goldPhrase(goldPerGlim)} on Habitica for a glim.`,
  capReached: 'Top-ups can’t bring any more glims today. More after midnight UTC.',

  // ---- outcomes (one line each, in the card and as a toast)
  moved: (glims: number, before: number | null, after: number | null) =>
    before !== null && after !== null
      ? `${glimsCount(glims)} caught the light. Habitica: ${amountNumber(before)} → ${goldPhrase(after)}.`
      : `${glimsCount(glims)} caught the light.`,
  movedChecked: (glims: number, gold: number) => `Habitica was slow to answer, but your gold there went down by ${amountNumber(gold)}, so ${glimsCount(glims)} caught the light.`,
  notEnough: 'Habitica says there isn’t that much gold there now. Nothing moved.',
  notMoved: 'Habitica didn’t take the gold, and your balance there didn’t change. Nothing moved, and it didn’t use up a top-up.',
  unconfirmed: 'Habitica didn’t answer, and we couldn’t tell whether your gold moved. No glims yet; your glim log shows this one as not confirmed.',
  tokenRefused: 'Habitica didn’t accept your token. Connect again and try once more.',
  leftover: 'If a reward called “Glimway purse” is still in your Habitica Rewards, don’t buy it. It’s removed the next time you top up.',
  lost: 'The world didn’t answer. If gold moved, it shows in your glim log soon.',
  notSent: 'Needs a connection. Nothing was sent, and no gold moved.',

  // ---- the log
  logTitle: 'Glim log',
  logEmpty: 'Nothing yet. Top-ups, buys, sales, letters and gifts show here.',
  logLoading: 'Reading your glim log…',
  logNote: 'The last 50 lines, newest first. Habitica keeps no record of top-ups; this log is the record.',
  closeLog: 'Close the glim log',
  closeConsent: 'Close',

  // ---- glims elsewhere
  give: 'Give…',
  giveTo: 'Hand glims to',
  giveNobody: 'Stand next to someone to hand glims over.',
  giveLabel: 'How many glims',
  giveButton: (n: number | null) => (n ? `Give ${glimsCount(n)}` : 'Give glims'),
  gave: (name: string, n: number) => `You gave ${name} ${glimsPhrase(n)}.`,
  gaveYou: (name: string, n: number) => `${name} gave you ${glimsPhrase(n)}.`,
  mailRow: 'Glims',
  mailLabel: 'How many glims',
  mailSend: (n: number | null) => (n ? `Send ${glimsCount(n)}` : 'Send glims'),
  mailSent: (name: string, n: number) => `Sent ${glimsPhrase(n)} to ${name}. ${Math.floor(n) === 1 ? 'It waits' : 'They wait'} in their mailbox.`,
  needsConnection: 'Needs a connection.',
  /** The goodbye a seller's choices end on when his talk had none. */
  notYet: 'Not yet'
} as const

/** Glims on the gate shelf (purse-and-wardrobe.md 3.2, in glims). */
export const shelfCopy = {
  lede: 'Gifts and goods for travellers on the Commons lane. Take one gift a day; buy what has a price.',
  buy: (price: number) => `Buy · ${glimsCount(price)}`,
  buying: 'Buying…',
  bought: (what: string, price: number) => `You bought ${what} for ${glimsPhrase(price)}.`,
  yours: 'Your stock',
  short: (price: number) => `Needs ${glimsCount(price)}`,
  priceLabel: 'Price in glims (leave it empty for a free gift)',
  pricePlaceholder: 'Free',
  priceHint: (max: number) => `A whole number from 1 to ${amountNumber(max)}, or empty for a gift.`,
  pickPriced: (price: number) => `Choose something from your pack to sell for ${glimsPhrase(price)}:`,
  stockedPriced: (price: number) => `On the shelf for ${glimsPhrase(price)}. The glims come to you when someone buys it.`
} as const

/** The glim log's words for a line, by its ledger reason (2.1's sheet, in glims). */
export const logReasonCopy = {
  topUp: (glims: number, state: string) => `Top-up · ${glimsCount(glims)} · ${state}`,
  topUpHabitica: (before: number | null, after: number | null) =>
    before === null ? 'Habitica: not read' : `Habitica ${amountNumber(before)} → ${after === null ? '?' : goldPhrase(after)}`,
  topUpLine: 'Top-up · moved',
  settled: 'Top-up · settled by the owner',
  merged: (gold: number) => (gold > 0 ? `Your purse’s ${goldPhrase(gold)}, turned into glims (two gold each)` : 'Your purse’s gold, turned into glims (two gold each)'),
  spend: 'Spent on a rest, a lantern or the chest',
  quest: 'Paid along a quest',
  mend: (what: string) => `Paid to mend ${what}`,
  deed: 'A deed from Silas',
  upgrade: 'Building work by Silas',
  homeBuy: (what: string) => `Bought ${what} from Silas`,
  clear: 'Silas cleared a tile on your land',
  bought: (what: string, from: string) => (from ? `Bought ${what} from ${from}` : `Bought ${what}`),
  shelfBuy: (what: string, from: string) => (from ? `Bought ${what} from ${from}’s shelf` : `Bought ${what} from a shelf`),
  shelfSale: (who: string, what: string) => `${who || 'A traveller'} bought ${what} from your shelf`,
  mailSend: (who: string, state: string) => `Sent to ${who || 'a friend'} in a letter${state ? ` · ${state}` : ''}`,
  mailClaim: (who: string) => `In a letter from ${who || 'a friend'}`,
  mailReturn: (who: string) => `Letter to ${who || 'a friend'} came back uncollected`,
  mailRecall: (who: string) => `Letter to ${who || 'a friend'} recalled`,
  give: (who: string) => `Handed to ${who || 'a friend'}`,
  gift: (who: string) => `Handed to you by ${who || 'a friend'}`,
  other: 'Glims'
} as const

/** A top-up's state, as the log says it. */
export const topUpStateWords: Readonly<Record<string, string>> = {
  working: 'on its way',
  moved: 'moved',
  'not-enough': 'not enough',
  'not-moved': 'not moved',
  unconfirmed: 'not confirmed'
}

/** A glim letter's state, as the log says it. */
export const mailStateWords: Readonly<Record<string, string>> = {
  waiting: 'waiting',
  collected: 'collected',
  'came-back': 'came back'
}
