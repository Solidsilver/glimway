/**
 * The found texts' markdown-ish bodies → plain blocks the reader renders
 * with ordinary elements (never {@html}). Covers what the owner's texts use:
 * paragraphs whose line breaks matter (songs, rhymes, ledgers), bullet and
 * numbered lists, **bold**, *italic*, `pencil`, editorial asides
 * ("*(In the margin…)*"), the handwritten notes that follow them, and
 * signatures ("- Dad", "— S.", "Love,\nJoss").
 */

export interface Inline {
  text: string;
  b?: true;
  i?: true;
  /** Backtick text: a pencilled note in someone's hand. */
  pencil?: true;
}

export type Line = Inline[];

/**
 * plain: the document itself. intro: an opening italic note about the text.
 * aside: an editor's/finder's stage direction ("(Beneath this, in ink…)").
 * hand: words written onto the document by someone afterwards.
 * sign: a signature or valediction.
 */
export type Tone = 'plain' | 'intro' | 'aside' | 'hand' | 'sign';

export type Block =
  | { kind: 'para'; tone: Tone; lines: Line[] }
  | { kind: 'list'; ordered: boolean; tone: Tone; items: Line[] }
  | { kind: 'heading'; level: number; line: Line };

/** Inline emphasis: **bold**, *italic*, `pencil`. Unmatched markers stay literal. */
export function parseInline(src: string): Line {
  const out: Inline[] = [];
  let b = false;
  let i = false;
  let buf = '';
  const flush = () => {
    if (!buf) return;
    const piece: Inline = { text: buf };
    if (b) piece.b = true;
    if (i) piece.i = true;
    out.push(piece);
    buf = '';
  };
  let k = 0;
  while (k < src.length) {
    if (src[k] === '`') {
      const end = src.indexOf('`', k + 1);
      if (end > k) {
        flush();
        const piece: Inline = { text: src.slice(k + 1, end), pencil: true };
        if (b) piece.b = true;
        if (i) piece.i = true;
        out.push(piece);
        k = end + 1;
        continue;
      }
    }
    if (src.startsWith('**', k) && (b || src.indexOf('**', k + 2) > k)) {
      flush();
      b = !b;
      k += 2;
      continue;
    }
    if (src[k] === '*' && (i || hasCloser(src, k + 1))) {
      flush();
      i = !i;
      k += 1;
      continue;
    }
    buf += src[k];
    k += 1;
  }
  flush();
  return mergeAdjacent(out);
}

/** A single '*' that opens italics needs a lone closing '*' later on. */
function hasCloser(src: string, from: number): boolean {
  for (let k = from; k < src.length; k++) {
    if (src[k] !== '*') continue;
    if (src[k + 1] === '*') {
      k++;
      continue;
    }
    return true;
  }
  return false;
}

function mergeAdjacent(line: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const piece of line) {
    const prev = out[out.length - 1];
    if (prev && prev.b === piece.b && prev.i === piece.i && prev.pencil === piece.pencil) prev.text += piece.text;
    else out.push({ ...piece });
  }
  return out;
}

export function lineText(line: Line): string {
  return line.map((p) => p.text).join('');
}

const BULLET = /^(?:[-*])\s+(.*)$/;
const NUMBERED = /^\d+\.\s+(.*)$/;

/** A paragraph that is italic from end to end (ignoring trailing punctuation). */
function allItalic(lines: Line[]): boolean {
  const pieces = lines.flat().filter((p) => p.text.trim() !== '' && !/^[\s:.,)(]+$/.test(p.text));
  return pieces.length > 0 && pieces.every((p) => p.i);
}

/**
 * Asides that introduce later handwriting: "(…in a Keeper's hand:)",
 * "(On the reverse, in the same hand, smaller:)", "(Beneath this…:)".
 */
function introducesHand(text: string): boolean {
  const t = text.trim();
  return /\bhand\b/i.test(t) || (t.startsWith('*(') && /:\s*\)?\s*\*?\s*\)?$/.test(t));
}

function isSignatureLine(text: string): boolean {
  const t = text.trim();
  return /^[—–]\s?\S/.test(t) && t.length <= 40;
}

export function parseBody(body: string): Block[] {
  const blocks: Block[] = [];
  const chunks = body.replace(/\r\n/g, '\n').split(/\n\s*\n/);
  let handRun = false;
  chunks.forEach((chunk, index) => {
    const raw = chunk.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    if (raw.length === 0) return;

    const heading = /^(#{2,4})\s+(.*)$/.exec(raw[0]);
    if (heading && raw.length === 1) {
      handRun = false;
      blocks.push({ kind: 'heading', level: heading[1].length, line: parseInline(heading[2]) });
      return;
    }

    // Lists: every line is an item (continuation lines join the previous item).
    const bullet = BULLET.test(raw[0]);
    const numbered = NUMBERED.test(raw[0]);
    if (bullet || numbered) {
      const re = bullet ? BULLET : NUMBERED;
      const items: string[] = [];
      for (const l of raw) {
        const m = re.exec(l);
        if (m) items.push(m[1]);
        else if (items.length) items[items.length - 1] += ' ' + l;
        else items.push(l);
      }
      // "- Dad" under a letter is a signature, not a one-item list.
      if (items.length === 1 && bullet && /^[A-Z][A-Za-z.]*(?: [A-Z][A-Za-z.]*){0,2}$/.test(items[0])) {
        blocks.push({ kind: 'para', tone: 'sign', lines: [parseInline(items[0])] });
        return;
      }
      blocks.push({ kind: 'list', ordered: numbered, tone: handRun ? 'hand' : 'plain', items: items.map(parseInline) });
      return;
    }

    const lines = raw.map(parseInline);
    const text = raw.join(' ');
    let tone: Tone = handRun ? 'hand' : 'plain';
    if (allItalic(lines)) {
      if (index === 0 && !text.startsWith('*(') && !/:\*?\)?\*?$/.test(text)) {
        tone = 'intro';
      } else {
        tone = 'aside';
        handRun = introducesHand(text);
      }
    } else if (raw.length === 1 && isSignatureLine(raw[0])) {
      tone = 'sign';
    } else if (raw.length === 2 && /^[A-Z][a-z]+,$/.test(raw[0]) && raw[1].split(/\s+/).length <= 3) {
      // "Love,\nJoss" closing a letter.
      tone = 'sign';
    } else if (lines[0][0]?.b && /margin|annotation/i.test(lines[0][0].text)) {
      // "**Silas's Margin Note:** …" — the annotator's own words.
      tone = 'hand';
    }
    blocks.push({ kind: 'para', tone, lines });
  });
  return blocks;
}
