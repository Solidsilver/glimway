/**
 * Ways home in the world (roadmap 0.13; docs/design/lamps.md §1.4). From the
 * pack (EV.waysHome): hold still for the item's pause, a ring filling over
 * the hero, then ask the server to take you (api/ways_home.go). Moving lets
 * go of it, and so do a fight closing in and anything else taking the screen
 * (a panel, a scene change, the tab hidden); either way nothing is spent.
 * The server moves the hero and the scene follows (EV.relocate). Binding a
 * pouch to the lamp beside you (EV.waysHomeBind) needs no pause.
 */
import { onSceneEnd } from './scene-end.ts'
import Phaser from 'phaser'
import { WAYS_HOME_LINES, WayPause, pauseMs, type WayHome } from '../lib/ways-home.ts'
import { waysHomeErrorText } from '../content/errors.ts'
import { bus, EV } from './events.ts'
import { sfx } from './sfx.ts'
import { itemsFor } from './items.ts'
import type { Session } from './session.ts'

export interface WaysHomeDeps {
  session: Session
  hero: () => { x: number; y: number }
  /** Enemies close enough that this is a fight (the sync gate's rule). */
  threatened: () => boolean
  /** A scene change is under way: nothing starts. */
  transitioning: () => boolean
  notePosition: () => void
  reducedMotion: boolean
}

/** The ring's warm light. */
const RING = 0xffb054

export class WaysHome {
  private pause: { way: WayHome; p: WayPause } | null = null
  private ring: Phaser.GameObjects.Graphics
  private busy = false

  constructor(private scene: Phaser.Scene, private deps: WaysHomeDeps) {
    this.ring = scene.add.graphics().setDepth(4002).setVisible(false)
    const onUse = (d: { way: WayHome }) => this.start(d.way)
    const onBind = () => void this.bind()
    const onHidden = () => void (document.visibilityState === 'hidden' && this.letGo())
    const page = typeof document === 'undefined' ? null : document
    bus.on(EV.waysHome, onUse)
    bus.on(EV.waysHomeBind, onBind)
    page?.addEventListener('visibilitychange', onHidden)
    onSceneEnd(scene, () => {
      bus.off(EV.waysHome, onUse)
      bus.off(EV.waysHomeBind, onBind)
      page?.removeEventListener('visibilitychange', onHidden)
      this.pause?.p.cancel()
      this.pause = null
    })
  }

  private say(text: string, kind: 'info' | 'error' | 'thought' = 'info'): void {
    bus.emit(EV.toast, { text, icon: 'lantern', kind })
  }

  /** Begin the pause where the hero stands. */
  private start(way: WayHome): void {
    if (this.pause || this.busy || this.deps.transitioning() || !this.deps.session.link) return
    if (this.deps.threatened()) {
      sfx('fizzle')
      this.say(WAYS_HOME_LINES.fight, 'error')
      return
    }
    this.pause = { way, p: new WayPause(this.scene.time.now, this.deps.hero(), pauseMs(way)) }
    sfx('glim')
    this.say(WAYS_HOME_LINES.start[way], 'thought')
  }

  update(): void {
    const held = this.pause
    if (!held) return
    const now = this.scene.time.now
    const hero = this.deps.hero()
    const state = held.p.tick(now, hero, this.deps.threatened())
    if (state === 'holding') {
      this.draw(hero, held.p.progress(now))
      return
    }
    this.pause = null
    this.ring.setVisible(false)
    if (state === 'moved' || state === 'fight') {
      sfx('fizzle')
      this.say(state === 'moved' ? WAYS_HOME_LINES.moved : WAYS_HOME_LINES.fight, 'error')
      return
    }
    void this.travel(held.way)
  }

  /**
   * Something else took the screen (the scene holds play for a panel, a
   * scene change or a cinematic, or the tab was hidden): the pause lets go,
   * said on the next play frame. A slow frame is not that: the hero stood
   * still through it (CI, 2026-10-19: a 2.2 s frame let go of a turncap with
   * "You moved").
   */
  letGo(): void {
    this.pause?.p.cancel()
  }

  private draw(hero: { x: number; y: number }, f: number): void {
    const g = this.ring
    g.clear().setVisible(true)
    const x = hero.x, y = hero.y - 30, r = 6
    g.lineStyle(2, 0x000000, 0.35).strokeCircle(x, y, r)
    g.lineStyle(2, RING, this.deps.reducedMotion ? 1 : 0.6 + 0.4 * f)
    g.beginPath().arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2, false).strokePath()
  }

  /** The pause held: ask the server to take you. */
  private async travel(way: WayHome): Promise<void> {
    const link = this.deps.session.link
    if (!link || this.busy) return
    this.busy = true
    this.deps.notePosition()
    try {
      const r = await link.waysHome({ action: way, lamp: '' })
      if (!r.ok) {
        sfx('fizzle')
        this.say(waysHomeErrorText(r.code), 'error')
        return
      }
      sfx('discover')
      const b = r.result.binding
      this.say(way === 'pouch' && b ? WAYS_HOME_LINES.arrivedBeside(b) : WAYS_HOME_LINES.arrived.turncap)
      void itemsFor(this.deps.session).load()
    } finally {
      this.busy = false
    }
  }

  /** Bind your pouch to the lamp beside you. */
  private async bind(): Promise<void> {
    const link = this.deps.session.link
    if (!link || this.busy) return
    this.busy = true
    this.deps.notePosition()
    try {
      const r = await link.waysHome({ action: 'bind', lamp: '' })
      if (!r.ok) {
        sfx('fizzle')
        this.say(waysHomeErrorText(r.code), 'error')
        return
      }
      sfx('lantern')
      if (r.result.binding) this.say(WAYS_HOME_LINES.bound(r.result.binding))
      bus.emit(EV.waysHomeBound, { binding: r.result.binding ?? null })
    } finally {
      this.busy = false
    }
  }

  /** For playtests: whether a pause is held, and how far through. */
  debug(): { way: WayHome | null; progress: number; busy: boolean } {
    return { way: this.pause?.way ?? null, progress: this.pause ? this.pause.p.progress(this.scene.time.now) : 0, busy: this.busy }
  }
}
