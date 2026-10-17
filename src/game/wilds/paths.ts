/**
 * Making paths on the open map (docs/design/open-map.md section 3,
 * decisions 5, 7 and 23): clear brush or a thicket with the spade in hand,
 * a fallen trunk with the axe; lay stone or plank under your feet; lift a
 * path you laid. Each is shown at once (predicted in the store, so the
 * window patches the chunk) and sent to the server, one after another; the
 * answer's ground and balances replace the prediction, and a refusal takes
 * it back with the reason in plain words.
 *
 * - Clearing is the action button: one prompt, on the clearable tile in
 *   reach that you face, while the right tool is in hand.
 * - Laying and lifting are L (stone, or lift) and P (plank), held to keep
 *   laying as you walk, and context buttons while the spade is in hand or
 *   you stand on or beside a laid path.
 * - The first lay on land that turns, each wick, asks first: "This land
 *   turns in N days. A path here stays if someone walks here each wick.
 * - A lay that joins two places names a way; a lift that breaks one says so.
 */
import type Phaser from 'phaser'
import { PATH_LABELS, PATH_REFUSALS, TURNS_CONFIRM } from '../../content/open-map.ts'
import { TILE, tileBottom, tileKey, tileMid } from '../../lib/tile.ts'
import { loadWilds } from '../../lib/wilds/data.ts'
import { chunkOf, epochKindAt, localOf } from '../../lib/wilds/coords.ts'
import { chunkKey } from './coords.ts'
import { checkClear, checkLay, checkLift, inReach, isLaid, layKinds, refusalText, turnsInText } from '../../lib/wilds/paths.ts'
import type { GroundChange } from '../../lib/gen/glimway/v1/wilds_pb.js'
import { hideContextButtons, showContextButton } from '../context-buttons.ts'
import { openDialogue } from '../dialogue.ts'
import { bus, EV } from '../events.ts'
import { heldNow } from '../held.ts'
import { uiBlocked } from '../input.ts'
import { sfx } from '../sfx.ts'
import { gameNow } from '../clock.ts'
import type { Session } from '../session.ts'
import type { Effects } from '../entities/fx.ts'
import type { Interactable, Interactables } from '../entities/interactables.ts'
import { chunkEpoch, chunkHeld, predictGround, settlePrediction, wildsEpoch, wildsLive, wildsMaterials, wildsView } from './store.ts'
import { lastOutcome, noteOutcome, release, settleWildsOp, trackOp, tracked } from './ops.ts'
import { newKey } from '../../lib/api/client.ts'
import { pathTileAt } from './path-tile.ts'

export { pathTileAt }

export interface PathsDeps {
  session: Session
  interactables: Interactables
  fx: Effects
  reducedMotion: boolean
  hero: () => { sprite: { x: number; y: number }; facing: { x: number; y: number } }
  /** Write where the hero stands into the save (the server measures reach from it). */
  notePosition: () => void
  /** The world takes input now (no panel, dialogue or move holds it). */
  live: () => boolean
}

/** A path operation waiting for its turn on the link, with the land it was made in. */
interface Job {
  op: 'clear' | 'lay' | 'lift'
  tx: number
  ty: number
  kind?: string
  /** What the prediction showed (settled with the operation). */
  token: number
  /** Where the hero stood when it was asked (the server measures reach from there). */
  where: { area: string; x: number; y: number }
  /** The world, the wick and the chunk's epoch it was made under. */
  world: string
  wick: string
  epoch: string
  cx: number
  cy: number
  /** For the words: the tool action, the material, the decor cleared. */
  action?: string
  material?: string
  decor?: string
  tries: number
}

const LAY_KEYS: Record<string, string> = { stone: 'L', plank: 'P' }
const CONFIRM_PREFIX = 'glimway-paths-confirmed:'
/** The prompt's reach from the hero's feet (the tile itself is checked against `paths.reachTiles`). */
const CLEAR_REACH = 56

/** A text field has the keys (a name, a note): L and P are letters there. */
const typing = () => {
  const el = typeof document === 'undefined' ? null : document.activeElement
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)
}

export class WildsPaths {
  private queue: Job[] = []
  private running = false
  private clearAt: { tx: number; ty: number; decor: string; action: string } | null = null
  private shown = ''
  /** A lay key held down: lay again on each new tile you step on. */
  private holding: { kind: string; last: string } | null = null
  private keys: Phaser.Input.Keyboard.Key[] = []
  /** What the prompt and buttons were last worked out from. */
  private readFor = ''
  private readonly deps: PathsDeps

  constructor(scene: Phaser.Scene, deps: PathsDeps) {
    this.deps = deps
    const self = this
    const point: Interactable = {
      id: 'wilds:path-clear',
      get x() {
        return self.clearAt ? tileMid(self.clearAt.tx) : -1e9
      },
      get y() {
        return self.clearAt ? tileBottom(self.clearAt.ty) : -1e9
      },
      reach: CLEAR_REACH,
      clickReach: CLEAR_REACH,
      // Digging a stump or a patch in reach comes first: clearing is for where there's nothing else to work.
      rank: -1,
      markerOffset: 14,
      label: () => (self.clearAt ? PATH_LABELS.clear[self.clearAt.decor] ?? PATH_LABELS.clear.thicket : null),
      verb: PATH_LABELS.clearVerb,
      available: () => self.clearAt !== null && self.live(),
      activate: () => {
        const at = self.clearAt
        if (at) self.clear(at.tx, at.ty)
      },
    }
    deps.interactables.register(this, [point])
    const kb = scene.input.keyboard
    if (kb) {
      for (const [kind, code] of Object.entries(LAY_KEYS)) {
        const key = kb.addKey(code, false)
        key.on('down', () => this.press(kind))
        key.on('up', () => {
          if (this.holding?.kind === kind) this.holding = null
        })
        this.keys.push(key)
      }
    }
    scene.events.once('shutdown', () => {
      for (const k of this.keys) k.removeAllListeners()
      this.keys = []
      hideContextButtons('path-')
      deps.interactables.register(this, [])
    })
  }

  /** Paths are made only on a fresh view of the open map, connected. */
  private live(): boolean {
    return !!this.deps.session.link && wildsLive(this.deps.session) !== null
  }

  private heroTile(): { tx: number; ty: number } {
    const h = this.deps.hero().sprite
    return { tx: Math.floor(h.x / TILE), ty: Math.floor(h.y / TILE) }
  }

  // ------------------------------------------------------------ per frame

  update(): void {
    const live = this.live() && this.deps.live()
    // What the prompt and the buttons read moves only with the hero's tile and facing, the hand, and the store.
    const here = this.heroTile()
    const f = this.deps.hero().facing
    const sig = `${live}|${here.tx},${here.ty}|${Math.round(f.x * 4)},${Math.round(f.y * 4)}|${heldNow().kind}|${wildsView()?.version ?? -1}`
    if (sig !== this.readFor) {
      this.readFor = sig
      this.clearAt = live ? this.findClear() : null
      this.updateButtons(live)
    }
    // Holding L or P: a path behind you as you walk.
    if (this.holding && live && !uiBlocked()) {
      const here = this.heroTile()
      const k = tileKey(here.tx, here.ty)
      if (k !== this.holding.last) {
        this.holding.last = k
        const t = pathTileAt(here.tx, here.ty)
        if (t && checkLay(t, this.holding.kind, wildsMaterials() ?? {}).ok) this.lay(this.holding.kind, true)
      }
    }
  }

  /** The clearable tile in reach that the hero faces, with the tool in hand. */
  private findClear(): { tx: number; ty: number; decor: string; action: string } | null {
    const held = heldNow()
    if (held.kind !== 'dig' && held.kind !== 'chop') return null
    const hero = this.deps.hero()
    const at = this.heroTile()
    const r = loadWilds().paths.reachTiles
    let best: { score: number; tx: number; ty: number; decor: string; action: string } | null = null
    for (let ty = at.ty - r; ty <= at.ty + r; ty++)
      for (let tx = at.tx - r; tx <= at.tx + r; tx++) {
        if ((tx === at.tx && ty === at.ty) || !inReach(at, { tx, ty })) continue
        const t = pathTileAt(tx, ty)
        if (!t) continue
        const c = checkClear(t, (action) => action === held.kind)
        if (!c.ok) continue
        const dx = tileMid(tx) - hero.sprite.x
        const dy = tileMid(ty) - hero.sprite.y
        const d = Math.hypot(dx, dy)
        const facing = d > 0 ? (dx * hero.facing.x + dy * hero.facing.y) / d : 0
        const score = d - facing * 14
        if (!best || score < best.score) best = { score, tx, ty, decor: c.decor, action: c.action }
      }
    return best && { tx: best.tx, ty: best.ty, decor: best.decor, action: best.action }
  }

  /** Lay and lift on the context buttons: with the spade in hand, or on or beside a laid path. */
  private updateButtons(live: boolean): void {
    const buttons: { id: string; label: string; key: string; press: () => void }[] = []
    if (live) {
      const here = this.heroTile()
      const t = pathTileAt(here.tx, here.ty)
      const me = this.deps.session.link?.accountId ?? ''
      const near = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => isLaid(pathTileAt(here.tx + dx!, here.ty + dy!)?.change?.change))
      if (t && (heldNow().kind === 'dig' || near)) {
        const lift = checkLift(t, me)
        if (lift.ok) buttons.push({ id: 'path-lift', label: PATH_LABELS.lift[lift.kind] ?? PATH_LABELS.lift.stone, key: LAY_KEYS.stone!, press: () => this.lift() })
        else if (!isLaid(t.change?.change) && checkLay(t, 'stone', { stone: 1, timber: 1 }).ok)
          for (const l of layKinds()) buttons.push({ id: `path-lay-${l.kind}`, label: PATH_LABELS.lay[l.kind] ?? l.kind, key: LAY_KEYS[l.kind] ?? '', press: () => this.lay(l.kind) })
      }
    }
    const sig = buttons.map((b) => `${b.id}:${b.label}`).join('|')
    if (sig === this.shown) return
    this.shown = sig
    hideContextButtons('path-')
    buttons.forEach((b, i) => showContextButton({ id: b.id, label: b.label, key: b.key, icon: 'stone', order: 10 + i, press: b.press }))
  }

  /** L or P pressed: lift your path here (L), or lay one; held, keep laying as you walk. */
  private press(kind: string): void {
    if (!this.deps.live() || uiBlocked() || typing()) return
    const here = this.heroTile()
    const t = pathTileAt(here.tx, here.ty)
    if (kind === 'stone' && t && checkLift(t, this.deps.session.link?.accountId ?? '').ok) {
      this.lift()
      return
    }
    this.holding = { kind, last: tileKey(here.tx, here.ty) }
    this.lay(kind)
  }

  // ------------------------------------------------------------ the operations

  private say(code: string, ctx: { action?: string; material?: string } = {}): void {
    noteOutcome(`refused:${code}`)
    bus.emit(EV.toast, { text: refusalText(code, { ...ctx, extra: PATH_REFUSALS }), icon: 'map', kind: 'thought' })
  }

  private whereNow(): { area: string; x: number; y: number } {
    this.deps.notePosition()
    const h = this.deps.hero().sprite
    return { area: 'outdoors', x: Math.round(h.x), y: Math.round(h.y) }
  }

  /** Clear the tile (world tiles): the tool in hand, within reach. */
  clear(tx: number, ty: number): void {
    if (!this.live()) return this.say('offline')
    const t = pathTileAt(tx, ty)
    if (!t) return this.say('not-clearable')
    if (!inReach(this.heroTile(), { tx, ty })) return this.say('too-far-away')
    const held = heldNow()
    const c = checkClear(t, (action) => action === held.kind)
    if (!c.ok) return this.say(c.code, { action: held.kind })
    const { cx, cy } = chunkOf(tx, ty)
    const { lx, ly } = localOf(tx, ty)
    const token = predictGround(cx, cy, lx, ly, this.change(lx, ly, 'cleared'))
    sfx('dig')
    this.deps.fx.sparkBurst(tileMid(tx), tileBottom(ty) - 6, 6)
    this.send({ op: 'clear', tx, ty, token, where: this.whereNow(), ...this.land(tx, ty), action: c.action, decor: c.decor, tries: 0 })
  }

  /**
   * Lay `kind` under the hero's feet. `quiet`: a lay while walking with the
   * key held (no refusal words for tiles it skips).
   */
  lay(kind: string, quiet = false): void {
    if (!this.live()) return quiet ? undefined : this.say('offline')
    const { tx, ty } = this.heroTile()
    const t = pathTileAt(tx, ty)
    if (!t) return quiet ? undefined : this.say('cannot-lay-here')
    const c = checkLay(t, kind, wildsMaterials() ?? {})
    if (!c.ok) {
      if (!quiet) this.say(c.code, { material: layKinds().find((l) => l.kind === kind)?.material })
      if (c.code === 'insufficient-materials') this.holding = null
      return
    }
    const { cx, cy } = chunkOf(tx, ty)
    // Land that turns: say so before the first lay this wick (the Tangle and held land keep their paths).
    const wick = wildsEpoch('wick')
    if (epochKindAt(cx, cy) === 'wick' && !chunkHeld(cx, cy) && wick.id && !this.confirmed(wick.id)) {
      this.holding = null
      const endsAt = wick.endsAt ?? gameNow() + 86_400
      openDialogue({
        id: 'wilds-path-confirm',
        speaker: TURNS_CONFIRM.title,
        lines: [wildsView()?.held.has(chunkKey(cx, cy)) ? TURNS_CONFIRM.held : turnsInText(endsAt, gameNow())],
        choices: [
          { text: TURNS_CONFIRM.yes, action: `path:lay:${kind}:${tx}:${ty}` },
          { text: TURNS_CONFIRM.no, dismiss: true },
        ],
      })
      return
    }
    this.layAt(kind, tx, ty, c.material, c.cost)
  }

  private layAt(kind: string, tx: number, ty: number, material: string, cost: number): void {
    const { cx, cy } = chunkOf(tx, ty)
    const { lx, ly } = localOf(tx, ty)
    const token = predictGround(cx, cy, lx, ly, this.change(lx, ly, kind), { id: material, delta: -cost })
    sfx('plant')
    this.send({ op: 'lay', tx, ty, kind, token, where: this.whereNow(), ...this.land(tx, ty), material, tries: 0 })
  }

  /** Lift your path under the hero's feet: its stone or timber comes back. */
  lift(): void {
    if (!this.live()) return this.say('offline')
    const { tx, ty } = this.heroTile()
    const t = pathTileAt(tx, ty)
    const me = this.deps.session.link?.accountId ?? ''
    const c = t ? checkLift(t, me) : ({ ok: false, code: 'not-your-path' } as const)
    if (!c.ok) return this.say(c.code)
    const { cx, cy } = chunkOf(tx, ty)
    const { lx, ly } = localOf(tx, ty)
    const token = predictGround(cx, cy, lx, ly, c.after ? this.change(lx, ly, 'cleared') : null, { id: c.material, delta: c.cost }, me)
    sfx('dig')
    this.send({ op: 'lift', tx, ty, token, where: this.whereNow(), ...this.land(tx, ty), material: c.material, tries: 0 })
  }

  /** A dialogue's choice (WorldActions `path:`): the confirm said yes. */
  onAction(rest: string): void {
    const m = /^lay:([a-z]+):(-?\d+):(-?\d+)$/.exec(rest)
    if (!m) return
    const wick = wildsEpoch('wick').id
    if (wick) this.confirm(wick)
    const [kind, tx, ty] = [m[1]!, Number(m[2]), Number(m[3])]
    const t = pathTileAt(tx, ty)
    const c = t && checkLay(t, kind, wildsMaterials() ?? {})
    if (!c || !c.ok) return this.say(c ? c.code : 'cannot-lay-here', { material: layKinds().find((l) => l.kind === kind)?.material })
    this.layAt(kind, tx, ty, c.material, c.cost)
  }

  private change(lx: number, ly: number, change: string): GroundChange {
    return { tx: lx, ty: ly, change, by: this.deps.session.link?.accountId ?? '', at: Math.floor(gameNow()) } as GroundChange
  }

  private confirmed(wick: string): boolean {
    try {
      return localStorage.getItem(CONFIRM_PREFIX + wick) === '1'
    } catch {
      return this.confirmedHere.has(wick)
    }
  }

  private confirmedHere = new Set<string>()
  private confirm(wick: string): void {
    this.confirmedHere.add(wick)
    try {
      localStorage.setItem(CONFIRM_PREFIX + wick, '1')
    } catch {
      /* kept for this visit */
    }
  }

  // ------------------------------------------------------------ the queue

  /** The land a tile is in now: the world, the wick and its chunk's epoch. */
  private land(tx: number, ty: number): Pick<Job, 'world' | 'wick' | 'epoch' | 'cx' | 'cy'> {
    const { cx, cy } = chunkOf(tx, ty)
    return { world: this.deps.session.link?.worldId ?? '', wick: wildsEpoch('wick').id, epoch: chunkEpoch(cx, cy)?.id ?? '', cx, cy }
  }

  /** Still the land the store holds? (A job from before the turning is never sent, but on a held chunk that didn't turn.) */
  private stillHere(job: Job): boolean {
    const turned = wildsEpoch('wick').id !== job.wick && !chunkHeld(job.cx, job.cy)
    return !turned && chunkEpoch(job.cx, job.cy)?.id === job.epoch && (this.deps.session.link?.worldId ?? '') === job.world
  }

  private send(job: Job): void {
    this.queue.push(job)
    void this.run()
  }

  /** Drop what is queued and unsent (its predictions go): the land turned, or the link can't take them now. */
  private cancelQueued(): void {
    for (const j of this.queue) settlePrediction(j.token)
    this.queue = []
    this.holding = null
  }

  /**
   * One operation at a time on the link, each under its own outbox key and
   * tracked until it settles (./ops.ts): its answer, a refusal or a replay
   * applies it there. A busy link (a claim in flight) is waited out; an
   * unanswered one keeps its prediction until the outbox settles it, and
   * what is queued behind it goes.
   */
  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length) {
        const job = this.queue[0]!
        const link = this.deps.session.link
        if (!link || !this.stillHere(job)) {
          this.queue.shift()
          settlePrediction(job.token)
          continue
        }
        const key = newKey()
        trackOp({ key, kind: job.op, world: job.world, wick: job.wick, epoch: job.epoch, cx: job.cx, cy: job.cy, token: job.token, action: job.action, material: job.material, decor: job.decor, account: link.accountId })
        const res = await link.wildsPath(job.op, { epoch: job.epoch, x: job.tx, y: job.ty, kind: job.kind, where: job.where, key })
        if (!res.ok && res.code === 'busy' && job.tries < 20 && tracked(key)) {
          // Never entered the outbox: the same job goes again, under a new key, its prediction kept.
          release(key)
          job.tries++
          await new Promise((r) => setTimeout(r, 250))
          continue
        }
        this.queue.shift()
        if (res.ok || !tracked(key)) continue
        if (res.code === 'pending') {
          // In the outbox, unanswered: it keeps showing until the outbox settles it.
          if (this.queue.length) this.say('pending')
          this.cancelQueued()
          return
        }
        // Refused before it reached the outbox (offline, a reload due): settled here.
        settleWildsOp({ kind: `wilds-${job.op}`, key, world: job.world, outcome: { ok: false, code: res.code } })
        if (res.code === 'offline' || res.code === 'busy') this.cancelQueued()
      }
    } finally {
      this.running = false
    }
  }

  // ------------------------------------------------------------ playtests

  debug(): { clearAt: { tx: number; ty: number } | null; queued: number; last: string; buttons: string } {
    return { clearAt: this.clearAt && { tx: this.clearAt.tx, ty: this.clearAt.ty }, queued: this.queue.length + (this.running ? 1 : 0), last: lastOutcome(), buttons: this.shown }
  }
}
