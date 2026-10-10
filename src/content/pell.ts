/**
 * Pell, the under-clerk (docs/design/silas-yard.md 2.6): the one who kept the
 * Brack convoy's "ghost account" carried forward at the Tarrow Count House
 * (docs/lore/texts/count-house-tally-book-scrap.md). The Count House sent
 * Pell up to keep the Commons plot ledger, in the small room through the side
 * door of Silas's Yard. Exact, kind, a little fussy, always at the desk.
 * Silas is glad of it: "I read timber, not ink."
 *
 * Pell's talk is deed things only, and short: buy a deed, take one back, sign
 * an invite, Manage your deed, Not today. The Manage your deed panel's words
 * are here too. The game (src/game/entities/homestead-talk.ts) and the panel
 * (src/ui/DeedPanel.svelte) pick these up; the rules for when each one shows
 * live there.
 *
 * Reveal order (./papers.ts): Pell talks about open accounts the way the
 * Count House does, never about who might still be on the road.
 */
import type { Dialogue } from './world.ts';
import { glimsCount } from './purse.ts';

export interface PellWords {
  name: string;
  bio: string;
  /** Once, the first time you talk to Pell: part of the first deed. */
  firstMeeting: Dialogue;
  /** One line each talk, in turn, before the choices. */
  idleLines: string[];
}

export const PELL: PellWords = {
  name: 'Pell',
  bio: 'The under-clerk the Tarrow Count House sent up to keep the Commons plot ledger. Ink on one finger, sleeve-guards on, always at the desk.',
  firstMeeting: {
    speaker: 'Pell',
    lines: [
      'Ah, a new name. Pell, under-clerk. The Count House sent me up from Tarrow to keep the Commons plot ledger.',
      'Silas builds, and I write down where. He says he reads timber, not ink. He’s right. He spelled “skid” three ways in one entry.',
      'Every gate on the lane has a page here. Choose one and I’ll enter your name. Properly, in ink, with the date.',
    ],
  },
  idleLines: [
    'Plot ledger’s open. Mind the ink.',
    'Iron-gall ink. It goes on grey and turns black overnight. I like to watch a name settle.',
    'The plot map shifts a little every Turning, so I re-pin it. The ledger doesn’t shift. That’s rather the point of a ledger.',
    'Pencil for the map, ink for the book. Mara and I agree on that, and on very little else about margins.',
    'Silas brings me his measurements in lantern-light and his spelling in his own way. Between us we make one good deed.',
    'At the Count House we never struck an account that wasn’t settled. I keep the Commons the same way.',
    'Carts used to log their loads on the Commons before the road. Now it’s houses. Still names. Still entered.',
    'One page in the book has a tea ring on it. That was before my time. I mention it so you know it wasn’t me.',
  ],
};

/** "about a minute", "about 30 seconds": how long Pell keeps the ink wet for the second name. */
function windowPhrase(seconds: number): string {
  if (seconds < 60) return `about ${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'about a minute' : `about ${minutes} minutes`;
}

/**
 * Pell's deed lines. `lot` is the gate's name as the lane says it
 * ("Lot 3", `lotName` in src/game/homestead.ts); `place` is the home's name
 * ("Tansy’s Place"); `price` is in glims.
 */
export const PELL_DEED = {
  /** The goodbye at the end of Pell's choices. */
  notToday: 'Not today',
  /** The choice that opens the Manage your deed panel (once you're on a deed). */
  manage: 'Manage your deed',

  /** Before a world is reachable, or while your page loads. */
  guest: 'Deeds are for folk with a world. Sign in to yours from the Menu and I’ll find you a page.',
  loading: 'One moment. I’m finding your page.',
  offline: 'The ledger can’t reach your world just now. Come back when the road is clear.',

  /** No home yet: said once, then the choices on their own. */
  pitch: 'Walk the lane, read the signs, choose a gate. Then come back and I’ll draw up the page. Land out here is measured in lantern-light.',

  // Buying a deed: the first is free, on the Compact; after that it costs glims.
  buy: (lot: string) => `The deed to ${lot}`,
  buyNote: (price: number) => (price === 0 ? 'First deed: free' : glimsCount(price)),
  buyShort: (price: number) => `Needs ${glimsCount(price)}`,
  /** Short of glims when the deed was bought (the server said no). */
  notEnoughGlims: 'You’re a few glims short for that page. It will keep. Pages are patient.',
  bought: (lot: string, price: number) =>
    price === 0
      ? `Entered: ${lot}, your name, today’s date. The first deed is on the Compact, so there’s nothing to pay. Your camp is set up past the gate.`
      : `${glimsCount(price)}, received and logged. ${lot} is yours, entered and blotted. Your camp is set up past the gate.`,

  // Taking back a deed you gave up, while its page is still held for you.
  takeBack: (lot: string) => `Take back ${lot}`,
  takeBackNote: 'Your old deed, as it stands · free',
  takeBackPitch: (lot: string) =>
    `Your old page is still in the book: ${lot}. One line through your name, neat, so it can still be read. Say so and I’ll write you back in.`,
  takenBack: (lot: string) => `Written back in: ${lot}, same page, same ink. It’s as you left it, give or take the weeds.`,

  // Signing at the table together.
  invite: (from: string, lot: string) =>
    `${from} wants your name on their deed, ${lot}. You both sign here at the table, together. Two names, one entry.`,
  signInvite: (from: string) => `Sign ${from}’s deed`,
  signInviteNote: (lot: string) => `${lot} · together, at the table`,
  shareAsk: 'A joint deed, then. Same land, same say, two names. Who’s signing with you?',
  shareNobody: 'Both of you sign at the table, together. Bring them in. I’ll keep the page open.',
  /** Your name is down; the other has the confirm window to sign. */
  signedWaiting: (confirmWindowSeconds: number) =>
    `Your name’s down. Now the other signs, here at the table. I’ll keep the ink wet ${windowPhrase(confirmWindowSeconds)}.`,
  signedTogether: 'There. Two names, one entry, blotted. Mind you both keep the lamps lit.',

  // Giving up your place on the deed (the confirm dialog, then Pell's reply).
  giveUpTitle: 'Give up your place on the deed?',
  giveUpConfirm: 'Strike my name',
  giveUpShared: (place: string) =>
    `Pell strikes your name from ${place}. You keep your pack and your own chest; everything set out, the lantern posts and the home chest stay with the others.`,
  giveUpAlone: (place: string, desolateAfterDays: number, deedLostAfterDays: number) =>
    `Pell strikes your name from ${place}. You keep your pack and your own chest; everything set out, the lantern posts and the home chest stay with the land. With nobody on the deed it goes wild after ${desolateAfterDays} days, and after ${deedLostAfterDays} days the deed is lost. Until then Pell keeps the page and will write you back in, as it stands.`,
  struck: (shared: boolean) => [
    'One line through it, neat, so it can still be read. Your pack and your own chest go with you. The rest stays with the land.',
    shared ? 'The others keep the page. The lane has plenty of gates when you’re ready.' : 'I’ll keep your page a while, in case you change your mind.',
  ],
} as const;

/** The Manage your deed panel (silas-yard.md 2.6): headings, buttons and help lines. */
export const DEED_PANEL_COPY = {
  title: 'Your deed',
  where: (place: string, lot: string) => `${place} · ${lot}`,
  onTheDeed: (names: string) => `On the deed: ${names}`,

  shareHeading: 'Share it',
  atTable: 'At the table now:',
  offer: 'Offer to sign',
  shareHelp: 'Both of you sign at the table.',
  tableEmpty: 'Nobody else is at the table. Bring them in; Pell keeps the page open.',
  notAtTable: 'Stand at the deed table to share it.',
  offered: (name: string) => `Your name’s down. ${name} signs next, at the table.`,

  waitingHeading: 'Waiting for you',
  inviteRow: (from: string, lot: string) => `${from}’s deed · ${lot}`,
  sign: 'Sign',

  giveUp: 'Give up your place on the deed',
  giveUpHelp: (deedLostAfterDays: number) =>
    `No refund. If nobody else is on it, Pell keeps the page ${deedLostAfterDays} days for you to take back.`,
} as const;

/** Every line Pell or the deed panel can show, with sample names (the text rules in tests/pell.test.ts and tests/world.test.ts). */
export function allPellLines(): string[] {
  const d = PELL_DEED;
  const p = DEED_PANEL_COPY;
  return [
    ...PELL.firstMeeting.lines,
    ...PELL.idleLines,
    d.notToday, d.manage, d.guest, d.loading, d.offline, d.pitch,
    d.buy('Lot 3'), d.buyNote(0), d.buyNote(10), d.buyShort(10), d.notEnoughGlims, d.bought('Lot 3', 0), d.bought('Lot 3', 10),
    d.takeBack('Lot 2'), d.takeBackNote, d.takeBackPitch('Lot 2'), d.takenBack('Lot 2'),
    d.invite('Rowan', 'Lot 5'), d.signInvite('Rowan'), d.signInviteNote('Lot 5'), d.shareAsk, d.shareNobody,
    d.signedWaiting(60), d.signedWaiting(30), d.signedTogether,
    d.giveUpTitle, d.giveUpConfirm, ...d.struck(true), ...d.struck(false),
    p.title, p.where('Tansy’s Place', 'Lot 3'), p.onTheDeed('Tansy, Bram'), p.shareHeading, p.atTable, p.offer, p.shareHelp,
    p.tableEmpty, p.notAtTable, p.offered('Ivy'), p.waitingHeading, p.inviteRow('Rowan', 'Lot 5'), p.sign, p.giveUp, p.giveUpHelp(14),
  ];
}

/** The give-up dialog's bodies: longer than a talk line, so they're prose (shown in the confirm dialog). */
export function allPellProse(): string[] {
  return [PELL.bio, PELL_DEED.giveUpShared('Tansy’s Place'), PELL_DEED.giveUpAlone('Tansy’s Place', 3, 14)];
}
