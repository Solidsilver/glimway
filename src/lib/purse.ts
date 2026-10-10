/**
 * The gold purse, client side (docs/design/purse-and-wardrobe.md 2, 3, 6.5):
 * amounts, the consent card's numbers, top-ups left, every top-up's outcome
 * line, the purse log's lines, and the sellers' gold choices. No network and
 * no storage: the server owns the purse, and these only read what it sent.
 *
 * Gold comes into the purse only by a top-up the player asks for, and never
 * goes back to Habitica. The browser's Habitica client stays read-only: the
 * gold shown on the consent card is the sync's own read (display only); the
 * server reads Habitica again itself before anything moves.
 */
import type { PurseLine, PurseRead, PurseTopUp } from './gen/glimway/v1/purse_pb.js';
import type { PlayerState } from './gen/glimway/v1/state_pb.js';
import { logReasonCopy, mailStateWords, purseCopy, topUpStateWords } from '../content/purse.ts';
import { giftPhrase, ITEMS, type ItemSeller } from './items.ts';
import { homeItem } from './homestead.ts';

/** Two top-ups a UTC day (2.5); the server counts, this only words it. */
export const TOP_UPS_PER_DAY = 2;
/** Habitica's gold cap: the most one top-up can ask for (2.2). */
export const TOP_UP_MAX = 99_999_999;
/** The purse read's rhythm while a top-up is working (2.2, "The answer"). */
export const TOP_UP_POLL_MS = 3_000;
/** How long the client keeps polling a working top-up (the worker's limit is 60 s; a stale row settles at 90). */
export const TOP_UP_POLL_LIMIT_MS = 100_000;
/** The purse log's length (2.1). */
export const LOG_LINES = 50;

/** A top-up as the game keeps it. */
export interface TopUpView {
  id: string;
  amount: number;
  /** working | moved | not-enough | not-moved | unconfirmed */
  state: string;
  goldBefore: number | null;
  goldAfter: number | null;
  /** Unix seconds. */
  startedAt: number;
  settledAt: number | null;
  leftover: boolean;
  /** habitica-auth | timeout | checked | settled-by-owner | '' */
  note: string;
}

/** The purse as the game shows it: the server's, with unanswered gold operations on top. */
export interface PurseView {
  gold: number;
  topUpsLeft: number;
  working: TopUpView | null;
}

export const EMPTY_PURSE: PurseView = { gold: 0, topUpsLeft: TOP_UPS_PER_DAY, working: null };

export function topUpView(t: PurseTopUp): TopUpView {
  return {
    id: t.id,
    amount: t.amount,
    state: t.state,
    goldBefore: t.goldBefore ?? null,
    goldAfter: t.goldAfter ?? null,
    startedAt: t.startedAt,
    settledAt: t.settledAt ?? null,
    leftover: t.leftover,
    note: t.note,
  };
}

/** The purse a state carries (an empty one before the server sends any). */
export function purseOf(state: Pick<PlayerState, 'purse'> | null | undefined): PurseView {
  const p = state?.purse;
  if (!p) return { ...EMPTY_PURSE };
  // G-C: the purse's gold balance left the wire (glims are the one
  // balance, silas-yard.md 1.6); the purse UI goes with it.
  return { gold: 0, topUpsLeft: Math.max(0, p.topUpsLeft), working: p.working ? topUpView(p.working) : null };
}

/** The gold the sync's own read saw on Habitica (`stats.gp`, floored), or null when it carried none. */
export function habiticaGoldOf(rawUser: unknown): number | null {
  const stats = (rawUser as { stats?: { gp?: unknown } } | null | undefined)?.stats;
  const gp = stats?.gp;
  if (typeof gp !== 'number' || !Number.isFinite(gp) || gp < 0) return null;
  return Math.floor(gp);
}

/**
 * A typed amount: a whole number from 1 to `max`, or null. Thousands
 * separators and spaces are forgiven ("1,240"); anything else isn't.
 */
export function parseAmount(text: string, max: number): number | null {
  const t = String(text).replace(/[\s,]/g, '');
  if (!/^\d{1,9}$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n < 1 || n > Math.min(max, TOP_UP_MAX)) return null;
  return n;
}

/** Whether a top-up has an outcome yet. */
export const settled = (t: Pick<TopUpView, 'state'>): boolean => t.state !== 'working';

/**
 * What the player is told when a top-up settles (2.1's table), one line,
 * with the leftover warning added when a reward may still be on Habitica.
 * Null while it's still working.
 */
export function topUpOutcome(t: TopUpView): string | null {
  let line: string;
  switch (t.state) {
    case 'working':
      return null;
    case 'moved':
      line = t.note === 'checked' ? purseCopy.movedChecked(t.amount) : purseCopy.moved(t.amount, t.goldBefore, t.goldAfter);
      break;
    case 'not-enough':
      line = purseCopy.notEnough;
      break;
    case 'not-moved':
      line = t.note === 'habitica-auth' ? purseCopy.tokenRefused : purseCopy.notMoved;
      break;
    case 'unconfirmed':
      line = purseCopy.unconfirmed;
      break;
    default:
      line = purseCopy.lost;
  }
  return t.leftover ? `${line} ${purseCopy.leftover}` : line;
}

/** Whether an outcome is good news (the toast's tone). */
export const topUpMoved = (t: Pick<TopUpView, 'state'>): boolean => t.state === 'moved';

// ------------------------------------------------------------ the log

export interface LogEntry {
  /** Unix seconds. */
  at: number;
  /** "Bought timber ×4 from Silas". */
  text: string;
  /** "Habitica 1,240 → 1,040" (top-ups only). */
  detail: string;
  /** Gold in (+) or out (−); null for a top-up that moved nothing. */
  delta: number | null;
  kind: 'top-up' | 'line';
}

/** "timber ×4", "a whittled fox": what a line moved. */
function whatOf(itemDef: string, qty: number): string {
  if (!itemDef) return 'something';
  const home = homeItem(itemDef);
  if (home && !ITEMS.items.some((d) => d.id === itemDef)) return qty > 1 ? `${home.name.toLowerCase()} ×${qty}` : home.name.toLowerCase();
  const def = ITEMS.items.find((d) => d.id === itemDef);
  // Materials are counted, not numbered: "timber", "timber ×4".
  if (def?.kind === 'material') return qty > 1 ? `${def.name.toLowerCase()} ×${qty}` : def.name.toLowerCase();
  return qty > 1 ? `${giftPhrase(itemDef, 1).replace(/^(a|an) /, '')} ×${qty}` : giftPhrase(itemDef, 1);
}

/** One gold ledger line, in words (2.1's sheet). */
export function lineText(l: Pick<PurseLine, 'reason' | 'itemDef' | 'qty' | 'otherName' | 'mailState' | 'seller'>): string {
  const who = l.otherName;
  switch (l.reason) {
    case 'purse-settle':
      return logReasonCopy.settled;
    case 'habitica-topup':
      return logReasonCopy.topUpLine;
    case 'market-buy':
      return logReasonCopy.bought(whatOf(l.itemDef, l.qty), l.seller);
    case 'shelf-buy':
      return logReasonCopy.shelfBuy(whatOf(l.itemDef, l.qty), who);
    case 'shelf-sale':
      return logReasonCopy.shelfSale(who, whatOf(l.itemDef, l.qty));
    case 'mail-send':
      return logReasonCopy.mailSend(who, mailStateWords[l.mailState] ?? '');
    case 'mail-claim':
      return logReasonCopy.mailClaim(who);
    case 'mail-return':
      return logReasonCopy.mailReturn(who);
    case 'mail-recall':
      return logReasonCopy.mailRecall(who);
    case 'give':
      return logReasonCopy.give(who);
    case 'gift':
      return logReasonCopy.gift(who);
    default:
      return logReasonCopy.other;
  }
}

/** A top-up's log line: its amount, its outcome, and Habitica's gold before and after. */
export function topUpEntry(t: TopUpView): LogEntry {
  return {
    at: t.settledAt ?? t.startedAt,
    text: logReasonCopy.topUp(t.amount, topUpStateWords[t.state] ?? t.state),
    detail: logReasonCopy.topUpHabitica(t.goldBefore, t.state === 'moved' ? t.goldAfter : t.goldBefore === null ? null : t.goldAfter),
    delta: t.state === 'moved' ? t.amount : null,
    kind: 'top-up',
  };
}

/**
 * The purse log (GET /api/purse), newest first, at most LOG_LINES. Top-ups
 * come from their own rows, which say what Habitica's gold read before and
 * after; their `habitica-topup` ledger lines would only repeat them.
 */
export function purseLog(read: Pick<PurseRead, 'topUps' | 'lines'>): LogEntry[] {
  const out: LogEntry[] = read.topUps.map((t) => topUpEntry(topUpView(t)));
  for (const l of read.lines) {
    if (l.reason === 'habitica-topup') continue;
    out.push({ at: l.at, text: lineText(l), detail: '', delta: l.delta, kind: 'line' });
  }
  out.sort((a, b) => b.at - a.at);
  return out.slice(0, LOG_LINES);
}

/** "9 Oct" (the log's date column). */
export function logDate(at: number): string {
  return new Date(at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** "+ 12", "− 6" (the log's amount column). */
export function signed(delta: number): string {
  return `${delta < 0 ? '−' : '+'} ${Math.abs(delta).toLocaleString('en-US')}`;
}

// ------------------------------------------------------------ the sellers

/** A choice in a seller's talk (src/lib/dialogue.ts's shape, kept small here). */
export interface SellerChoice {
  text: string;
  reply?: string[];
  action: string;
}

/** A seller's choices: one per good, at its one price in glims (silas-yard.md 1.7). */
export function sellerChoices(seller: Pick<ItemSeller, 'id' | 'goods'>, opts: { reply?: boolean } = {}): SellerChoice[] {
  const out: SellerChoice[] = [];
  for (const g of seller.goods) {
    const reply = opts.reply ? { reply: [g.line] } : {};
    out.push({ text: g.label, ...reply, action: `buy:${seller.id}:${g.item}` });
  }
  return out;
}

/** A buy action's parts: `buy:<seller>:<good>` (the prefix already taken off). */
export function parseBuy(rest: string): { seller: string; good: string } | null {
  const [seller, good, more] = rest.split(':');
  if (!seller || !good || more !== undefined) return null;
  return { seller, good };
}

