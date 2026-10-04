/**
 * Pure parser for the connect guide's paste box. Both the User ID and the API
 * Token are UUIDs, so shape alone cannot tell them apart; labels can, and
 * otherwise we fall back to order of appearance (User ID first, as on
 * Habitica's settings page) and ask the player to confirm.
 *
 * No I/O, no logging. Error messages say what was found by COUNT only — they
 * never echo pasted text (it may be a token).
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID_RE = new RegExp(UUID, 'gi')
const UUID_EXACT = new RegExp(`^${UUID}$`, 'i')

export function isUuid(s: string): boolean {
  return UUID_EXACT.test(s.trim())
}

export type PasteResult =
  /** Fields known with confidence (separate fields, or matched by label). */
  | { kind: 'labeled'; userId: string; apiToken: string }
  /** Two bare UUIDs: assigned by order; the UI must preview and let the player swap. */
  | { kind: 'unlabeled'; userId: string; apiToken: string }
  | { kind: 'error'; found: number; message: string }

const USER_LABEL = String.raw`user[\s_-]*id`
const TOKEN_LABEL = String.raw`api[\s_-]*token`
// Between a label and its value: punctuation, quotes, whitespace, line breaks.
const GAP = String.raw`[\s:=\-–—>"'“”‘’\`(\[{]*`

function labeled(text: string, label: string): string | null {
  const m = new RegExp(`${label}${GAP}(${UUID})`, 'i').exec(text)
  return m ? m[1] : null
}

function count(n: number): string {
  return n === 0 ? 'no IDs' : n === 1 ? 'one ID' : `${n} IDs`
}

/** Parse the contents of a single paste box. */
export function parsePaste(text: string): PasteResult {
  const all = text.match(UUID_RE) ?? []

  const userId = labeled(text, USER_LABEL)
  const apiToken = labeled(text, TOKEN_LABEL)
  if (userId && apiToken) {
    if (userId.toLowerCase() === apiToken.toLowerCase()) {
      return { kind: 'error', found: all.length, message: 'The User ID and API Token labels pointed at the same value. Check what you copied.' }
    }
    return { kind: 'labeled', userId, apiToken }
  }

  // Exactly one label matched and two distinct codes were pasted: trust the
  // label for its value and give the other code to the other field.
  if ((userId || apiToken) && all.length === 2 && all[0].toLowerCase() !== all[1].toLowerCase()) {
    const labeledValue = (userId ?? apiToken)!.toLowerCase()
    const other = all.find((u) => u.toLowerCase() !== labeledValue)
    if (other) return userId ? { kind: 'labeled', userId, apiToken: other } : { kind: 'labeled', userId: other, apiToken: apiToken! }
  }

  if (all.length === 2 && all[0].toLowerCase() !== all[1].toLowerCase()) {
    return { kind: 'unlabeled', userId: all[0], apiToken: all[1] }
  }
  if (all.length === 2) {
    return { kind: 'error', found: 2, message: 'Found the same ID twice. The User ID and API Token are two different values.' }
  }
  const found = all.length
  const need = found < 2 ? 'We need both your User ID and your API Token.' : 'We need exactly two: your User ID and your API Token.'
  return { kind: 'error', found, message: `Found ${count(found)} in that paste. ${need}` }
}

/** Validate the two separate fields (today's form). */
export function parseFields(userId: string, apiToken: string): PasteResult {
  const u = userId.trim()
  const t = apiToken.trim()
  if (!u || !t) return { kind: 'error', found: 0, message: 'We need both your User ID and your API Token.' }
  if (!isUuid(u)) return { kind: 'error', found: 0, message: 'The User ID should look like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.' }
  if (!isUuid(t)) return { kind: 'error', found: 0, message: 'The API Token should look like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.' }
  if (u.toLowerCase() === t.toLowerCase()) {
    return { kind: 'error', found: 2, message: 'The User ID and API Token are two different values.' }
  }
  return { kind: 'labeled', userId: u, apiToken: t }
}

export function swapped(p: { userId: string; apiToken: string }): { userId: string; apiToken: string } {
  return { userId: p.apiToken, apiToken: p.userId }
}
