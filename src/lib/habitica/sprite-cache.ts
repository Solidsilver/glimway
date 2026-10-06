/**
 * Habitica outfit pieces the bundled cache lacks (playtest 1: every real
 * account had some). They come through our server's sprite proxy
 * (`/api/sprites/{name}.{png|gif}`, server/internal/api/sprites.go), which
 * fetches each from Habitica's public sprite host the first time anyone needs
 * it, and they are kept here in the browser's Cache Storage, so a piece is
 * downloaded once per device rather than once per visit. The proxy's answers
 * are also marked immutable for the ordinary HTTP cache, which is all a
 * browser without Cache Storage (an insecure context) gets.
 *
 * No Habitica credentials are involved: the request goes only to our own
 * origin (same-origin, so at most our own session cookie), and the server
 * asks the sprite host with nothing of the player's. The Habitica token
 * never leaves the login exchange.
 */
import { proxiedSpriteUrl } from './avatar.ts';

export const SPRITE_CACHE = 'fs-habitica-sprites-v1';

export interface SpriteCacheDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Cache Storage, when the context has it (secure contexts only). */
  caches: CacheStorage | null;
  createObjectURL: (blob: Blob) => string;
}

function browserDeps(): SpriteCacheDeps {
  return {
    fetch: (url, init) => globalThis.fetch(url, init),
    caches: typeof globalThis.caches !== 'undefined' ? globalThis.caches : null,
    createObjectURL: (blob) => URL.createObjectURL(blob),
  };
}

const IMAGE = /^image\/(png|gif)\b/;

export class SpriteCache {
  /** Sprite name -> a loadable URL (an object URL of the kept bytes), per tab. */
  private urls = new Map<string, Promise<string | null>>();
  /** Names the proxy says don't exist upstream (not asked again this tab). */
  private missing = new Set<string>();
  private deps: SpriteCacheDeps | null;

  constructor(deps?: SpriteCacheDeps) {
    this.deps = deps ?? null;
  }

  /**
   * A same-origin URL Phaser can load for this upstream sprite, or null when
   * it can't be had right now (no server, or Habitica has no such piece). A
   * failure other than "no such piece" is tried again on the next ask.
   */
  src(name: string): Promise<string | null> {
    if (this.missing.has(name)) return Promise.resolve(null);
    const known = this.urls.get(name);
    if (known) return known;
    const p = this.load(name).then((url) => {
      if (url === null) this.urls.delete(name);
      return url;
    });
    this.urls.set(name, p);
    return p;
  }

  private async load(name: string): Promise<string | null> {
    const deps = (this.deps ??= browserDeps());
    const url = proxiedSpriteUrl(name);
    let cache: Cache | null = null;
    try {
      cache = deps.caches ? await deps.caches.open(SPRITE_CACHE) : null;
    } catch {
      cache = null; // storage blocked or full: the HTTP cache still helps
    }
    if (cache) {
      try {
        const hit = await cache.match(url);
        if (hit) {
          const blob = await hit.blob();
          if (blob.size > 0) return deps.createObjectURL(blob);
        }
      } catch {
        // a broken entry: fetch it afresh below
      }
    }
    let res: Response;
    try {
      res = await deps.fetch(url, { credentials: 'same-origin' });
    } catch {
      return null;
    }
    if (res.status === 404) {
      this.missing.add(name);
      return null;
    }
    if (!res.ok || !IMAGE.test(res.headers.get('content-type') ?? '')) return null;
    if (cache) {
      try {
        await cache.put(url, res.clone());
      } catch {
        // quota: this visit still has it
      }
    }
    return deps.createObjectURL(await res.blob());
  }
}

/** The tab's sprite cache. */
export const spriteCache = new SpriteCache();
