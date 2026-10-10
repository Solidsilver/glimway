/**
 * The purse's words (docs/design/purse-and-wardrobe.md 2.1, 3): the purse
 * card in the Menu, the consent card, every top-up outcome, the purse log,
 * and gold at the shelf, the mailbox and by hand. Plain and short: the
 * consent card says exactly what a top-up does to Habitica.
 *
 * The numbers are formatted by src/lib/purse.ts; nothing a server sends is
 * shown as text.
 */

/** "1,240" (the purse and Habitica's gold read the same way everywhere). */
export const goldNumber = (n: number): string => Math.max(0, Math.floor(n)).toLocaleString('en-US')

/** "240 gold". */
export const goldPhrase = (n: number): string => `${goldNumber(n)} gold`

export const purseCopy = {
  title: 'Your purse',
  balanceLabel: (n: number) => `${goldPhrase(n)} in your purse`,
  blurb: 'Gold moved in from Habitica. It buys goods from sellers and from friends’ shelves. It can’t go back.',
  topUp: 'Top up from Habitica',
  topUpBusy: 'Syncing first…',
  log: 'Purse log',
  topUpsLeft: (left: number, of: number) => `Top-ups left today: ${left} of ${of}.`,
  noTopUpsLeft: 'No top-ups left today. Two more after midnight UTC.',
  connectFirst: 'Connect to Habitica above first. Your details stay in this tab.',
  guest: 'Gold reaches your purse from friends: shelf sales, letters and gifts.',
  working: 'A top-up is still on its way. Its outcome shows here.',
  offline: 'Needs a connection. Topping up waits until you’re back online.',

  // ---- the consent card
  consentTitle: 'Move gold into your purse',
  youHave: (n: number) => `You have ${goldPhrase(n)} on Habitica.`,
  amountLabel: 'Gold to move',
  all: 'All',
  allTitle: 'Fill in all your Habitica gold. Nothing is sent until you press Move.',
  spends: 'This spends Habitica gold. Your Habitica balance goes down by this amount, the same as buying a reward there. Purse gold can’t go back to Habitica, and it can’t buy your own Habitica rewards.',
  how: 'Glimway adds a reward called “Glimway purse” to your Habitica Rewards for a moment, buys it, and removes it. Habitica keeps no record of this; your purse log does.',
  notNow: 'Not now',
  move: (n: number | null) => (n ? `Move ${goldPhrase(n)}` : 'Move gold'),
  moving: 'Moving gold…',
  checking: 'Checking with Habitica…',
  closeNote: 'You can close this. The outcome comes as a message.',
  amountHint: (max: number) => `A whole number from 1 to ${goldNumber(max)}.`,
  nothingThere: 'You have no gold on Habitica to move right now.',

  // ---- outcomes (one line each, in the card and as a toast)
  moved: (amount: number, before: number | null, after: number | null) =>
    before !== null && after !== null
      ? `${goldPhrase(amount)} moved into your purse. Habitica: ${goldNumber(before)} → ${goldNumber(after)}.`
      : `${goldPhrase(amount)} moved into your purse.`,
  movedChecked: (amount: number) => `Habitica was slow to answer, but your gold there went down by ${goldNumber(amount)}, so it’s in your purse.`,
  notEnough: 'Habitica says there isn’t that much gold there now. Nothing moved.',
  notMoved: 'Habitica didn’t take the gold, and your balance there didn’t change. Nothing moved, and it didn’t use up a top-up.',
  unconfirmed: 'Habitica didn’t answer, and we couldn’t tell whether your gold moved. Nothing is in your purse yet; your purse log shows this one as not confirmed.',
  tokenRefused: 'Habitica didn’t accept your token. Connect again and try once more.',
  leftover: 'If a reward called “Glimway purse” is still in your Habitica Rewards, don’t buy it. It’s removed the next time you top up.',
  lost: 'The world didn’t answer. If gold moved, it shows in your purse log soon.',

  // ---- the log
  logTitle: 'Purse log',
  logEmpty: 'Nothing yet. Top-ups, buys, sales, letters and gifts show here.',
  logLoading: 'Reading your purse log…',
  logNote: 'The last 50 lines, newest first. Habitica keeps no record of top-ups; this log is the record.',
  closeLog: 'Close the purse log',
  closeConsent: 'Close',

  // ---- the purse line (Hero page, Inventory)
  line: (n: number) => goldPhrase(n),
  openPurse: 'Purse',

  // ---- gold elsewhere
  give: 'Give…',
  giveTo: 'Hand gold to',
  giveNobody: 'Stand next to someone to hand gold over.',
  giveButton: (n: number | null) => (n ? `Give ${goldPhrase(n)}` : 'Give gold'),
  gave: (name: string, n: number) => `You gave ${name} ${goldPhrase(n)}.`,
  gaveYou: (name: string, n: number) => `${name} gave you ${goldPhrase(n)}.`,
  mailRow: 'Gold from your purse',
  mailSend: (n: number | null) => (n ? `Send ${goldPhrase(n)}` : 'Send gold'),
  mailSent: (name: string, n: number) => `Sent ${goldPhrase(n)} to ${name}. It waits in their mailbox.`,
  needsConnection: 'Needs a connection.'
} as const

/** Gold on the gate shelf (purse-and-wardrobe.md 3.2). */
export const shelfCopy = {
  lede: 'Gifts and goods for travellers on the Commons lane. Take one gift a day; buy what has a price.',
  buy: (price: number) => `Buy · ${goldPhrase(price)}`,
  buying: 'Buying…',
  bought: (what: string, price: number) => `You bought ${what} for ${goldPhrase(price)}.`,
  yours: 'Your stock',
  short: (price: number) => `Needs ${goldPhrase(price)} in your purse`,
  priceLabel: 'Price in gold (leave it empty for a free gift)',
  pricePlaceholder: 'Free',
  priceHint: (max: number) => `A whole number from 1 to ${goldNumber(max)}, or empty for a gift.`,
  pickPriced: (price: number) => `Choose something from your pack to sell for ${goldPhrase(price)}:`,
  stockedPriced: (price: number) => `On the shelf for ${goldPhrase(price)}. The gold comes to you when someone buys it.`
} as const

/** The purse log's words for a gold line, by its ledger reason (2.1's sheet). */
export const logReasonCopy = {
  topUp: (amount: number, state: string) => `Top-up · ${goldPhrase(amount)} · ${state}`,
  topUpHabitica: (before: number | null, after: number | null) =>
    before === null ? 'Habitica: not read' : `Habitica ${goldNumber(before)} → ${after === null ? '?' : goldNumber(after)}`,
  topUpLine: 'Top-up · moved',
  settled: 'Top-up · settled by the owner',
  bought: (what: string, from: string) => (from ? `Bought ${what} from ${from}` : `Bought ${what}`),
  shelfBuy: (what: string, from: string) => (from ? `Bought ${what} from ${from}’s shelf` : `Bought ${what} from a shelf`),
  shelfSale: (who: string, what: string) => `${who || 'A traveller'} bought ${what} from your shelf`,
  mailSend: (who: string, state: string) => `Sent to ${who || 'a friend'} in a letter${state ? ` · ${state}` : ''}`,
  mailClaim: (who: string) => `In a letter from ${who || 'a friend'}`,
  mailReturn: (who: string) => `Letter to ${who || 'a friend'} came back uncollected`,
  mailRecall: (who: string) => `Letter to ${who || 'a friend'} recalled`,
  give: (who: string) => `Handed to ${who || 'a friend'}`,
  gift: (who: string) => `Handed to you by ${who || 'a friend'}`,
  other: 'Gold'
} as const

/** A top-up's state, as the log says it. */
export const topUpStateWords: Readonly<Record<string, string>> = {
  working: 'on its way',
  moved: 'moved',
  'not-enough': 'not enough',
  'not-moved': 'not moved',
  unconfirmed: 'not confirmed'
}

/** A gold letter's state, as the log says it. */
export const mailStateWords: Readonly<Record<string, string>> = {
  waiting: 'waiting',
  collected: 'collected',
  'came-back': 'came back'
}
