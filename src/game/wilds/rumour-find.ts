/**
 * Opening this wick's rumoured find (open-map.md 2.10): a personal claim
 * like a chest's, under the wick it was drawn in. A fresh near read comes
 * first (claims name the current state); if that read names another wick,
 * the land has turned and this bundle is gone with it: nothing is sent. An
 * answer that lands after a turning isn't applied either (the Wilds are
 * read again for the balances).
 */
import type { Session } from '../session.ts'
import { claimEntity } from './remote.ts'
import { applyClaim, isClaimed, refreshNear, requestRead, wildsEpoch, wildsLive, type LootDrop } from './store.ts'
import { bus, EV } from '../events.ts'

export type RumourOpen = { ok: true; drop: LootDrop } | { ok: false; why: 'offline' | 'turned' | 'claimed' | 'refused'; code?: string }

/** Open the bundle at `site` (its id, its chunk), drawn in wick `siteEpoch`, from `where` (world pixels). */
export async function openRumourFind(session: Session, site: { id: string; cx: number; cy: number }, siteEpoch: string, where: { x: number; y: number }): Promise<RumourOpen> {
  if (!session.link) return { ok: false, why: 'offline' }
  await refreshNear(session, site.cx, site.cy)
  const epoch = wildsEpoch('wick').id
  if (!wildsLive(session) || !epoch) return { ok: false, why: 'offline' }
  if (epoch !== siteEpoch) return { ok: false, why: 'turned' }
  if (isClaimed(site.id)) return { ok: false, why: 'claimed' }
  const res = await claimEntity(session, { epoch: siteEpoch, entityId: site.id, cycle: 0, where })
  if (!res.ok) {
    if (res.code === 'epoch-ended') bus.emit(EV.turning, { reason: 'epoch-ended' })
    return { ok: false, why: 'refused', code: res.code }
  }
  if (wildsEpoch('wick').id !== siteEpoch || res.result.epoch !== siteEpoch) {
    requestRead()
    return { ok: false, why: 'turned' }
  }
  return { ok: true, drop: applyClaim(res.result) }
}
