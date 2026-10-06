/**
 * Passing thoughts: a line the hero notices (a bench, a flower, a cold camp)
 * shown in a small parchment bubble above the hero instead of a toast. One
 * at a time; a newer thought replaces the one showing. The UI sends them
 * (`EV.thought`) for toasts of `kind: 'thought'`.
 */
import Phaser from 'phaser'
import { bus, EV } from '../events'
import { uiState } from '../input'

/** Base time on screen, plus a little per character, capped. */
const BASE_MS = 1800
const PER_CHAR_MS = 28
const MAX_MS = 5200
/** Wrap width in world pixels (the bubble's text box). */
const WRAP = 120

/** Every thought shown this page (dev builds; read by __fsThoughts). */
const shownLog: string[] = []

export function thoughtMs(text: string): number {
  return Math.min(MAX_MS, BASE_MS + text.length * PER_CHAR_MS)
}

export class Thoughts {
  private bubble: Phaser.GameObjects.Container | null = null
  private timer: Phaser.Time.TimerEvent | null = null

  constructor(
    private scene: Phaser.Scene,
    private follow: { x: number; y: number },
    private opts: { reducedMotion: boolean; hidden: () => boolean; offsetY?: number }
  ) {
    bus.on(EV.thought, this.onThought, this)
    // Read-only, for playtests (dev builds): the thought on screen now, and every one shown.
    if (import.meta.env.DEV) {
      ;(window as unknown as { __fsThoughts?: () => { current: string | null; seen: string[] } }).__fsThoughts = () => ({
        current: this.current(),
        seen: [...shownLog]
      })
    }
    scene.events.on('postupdate', this.tick, this)
    scene.events.once('shutdown', () => this.destroy())
  }

  private onThought(p: { text?: string } | undefined): void {
    const text = p?.text?.trim()
    if (!text) return
    this.show(text)
  }

  show(text: string): void {
    this.clear()
    const s = this.scene
    const label = s.add
      .text(0, 0, text, {
        fontFamily: 'Nunito, sans-serif',
        fontSize: '7px',
        fontStyle: 'italic',
        color: '#3b2a1e',
        align: 'center',
        lineSpacing: -1,
        resolution: 8,
        wordWrap: { width: WRAP }
      })
      .setOrigin(0.5, 0.5)
    const w = Math.ceil(label.width) + 10
    const h = Math.ceil(label.height) + 6
    const g = s.add.graphics()
    g.fillStyle(0x2b1d1a, 1).fillRoundedRect(-w / 2 - 1, -h / 2 - 1, w + 2, h + 2, 5)
    g.fillStyle(0xfbf1da, 1).fillRoundedRect(-w / 2, -h / 2, w, h, 4)
    // A thought, not speech: two small dots trailing down to the hero.
    g.fillStyle(0x2b1d1a, 1).fillCircle(3, h / 2 + 3, 2.2).fillCircle(6, h / 2 + 7, 1.4)
    g.fillStyle(0xfbf1da, 1).fillCircle(3, h / 2 + 3, 1.3).fillCircle(6, h / 2 + 7, 0.6)
    const bubble = s.add.container(0, 0, [g, label]).setDepth(9000).setAlpha(0)
    bubble.setData('thought', text)
    if (import.meta.env.DEV) {
      shownLog.push(text)
      if (shownLog.length > 100) shownLog.shift()
    }
    bubble.setData('h', h)
    this.bubble = bubble
    this.place()
    s.tweens.add({ targets: bubble, alpha: 1, duration: this.opts.reducedMotion ? 80 : 180, ease: 'Quad.easeOut' })
    this.timer = s.time.delayedCall(thoughtMs(text), () => this.fade())
  }

  /** What's showing now (playtests), or null. */
  current(): string | null {
    return this.bubble?.active ? (this.bubble.getData('thought') as string) : null
  }

  private place(): void {
    const b = this.bubble
    if (!b?.active) return
    const h = b.getData('h') as number
    // A small lift as it appears (none under reduced motion).
    const lift = this.opts.reducedMotion ? 0 : 3 * Math.min(1, b.alpha * 1.5)
    b.setPosition(Math.round(this.follow.x), Math.round(this.follow.y + (this.opts.offsetY ?? -30) - h / 2 + 4 - lift))
  }

  private tick(): void {
    const b = this.bubble
    if (!b?.active) return
    this.place()
    b.setVisible(!this.opts.hidden() && !uiState.dialogueOpen)
  }

  private fade(): void {
    const b = this.bubble
    if (!b?.active) return
    this.scene.tweens.add({ targets: b, alpha: 0, duration: 260, onComplete: () => b.destroy() })
  }

  private clear(): void {
    this.timer?.remove(false)
    this.timer = null
    this.bubble?.destroy()
    this.bubble = null
  }

  destroy(): void {
    this.clear()
    bus.off(EV.thought, this.onThought, this)
    this.scene.events.off('postupdate', this.tick, this)
  }
}
