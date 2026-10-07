/**
 * Per-device conveniences kept as JSON in localStorage. Reads and writes
 * never throw: a private window, blocked storage or a damaged record just
 * means the fallback (on read) or nothing kept (on write).
 */

/**
 * The stored value under `key`, shaped by `parse` (given the parsed JSON;
 * it may throw). The fallback when nothing is stored or it can't be read.
 */
export function readJson<T>(key: string, parse: (value: unknown) => T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? parse(JSON.parse(raw) as unknown) : fallback;
  } catch {
    return fallback;
  }
}

/** Store `value` under `key`; false when storage refused it. */
export function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** A stored list of strings (anything else in it dropped). */
export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}
