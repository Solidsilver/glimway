/**
 * Where the quest goal is, shown rather than told: the HUD's needle turns
 * toward it (EV.goalDir), and when it's off screen a small lantern glint
 * sits on the screen's edge in its direction, inside the part of the
 * screen the interface leaves open (src/game/viewport.ts).
 *
 * In the goal's own area the guide points at the goal itself (Mara, the
 * route stone, the warden, the shrine lantern). Anywhere else it points at
 * the way out that leads toward it, by the road's areas: Hearthwick sits
 * between Brackenwood and the Commons, and Brackenwood leads to the ruin.
 */
import Phaser from 'phaser'
import { bus, EV, type GoalDirPayload } from '../events'
import { TILE } from '../textures'
import { playInsets } from '../viewport'
import type { QuestStage } from '../../lib/state'
import type { WorldData } from '../worlds'
import type { GuideWhere } from '../../content/guides'

/**
 * The places and the ways between them. Homesteads are by whose they are:
 * `home` and `cottage` are your own; someone else's lead back the way you
 * came. The Wilds are one place, through the Commons arch.
 */
const ROAD: Record<string, string[]> = {
  village: ['woodland', 'commons'],
  woodland: ['village', 'ruin'],
  ruin: ['woodland'],
  commons: ['village', 'home', 'wilds'],
  home: ['commons', 'cottage'],
  cottage: ['home'],
  'other-home': ['commons', 'other-cottage'],
  'other-cottage': ['other-home'],
  wilds: ['commons']
}

/** Where each "How do I…?" step's place is (src/content/guides.ts GuideWhere). */
const WHERE_PLACE: Record<GuideWhere, string> = {
  silas: 'commons',
  gate: 'commons',
  door: 'home',
  mailbox: 'home',
  bench: 'cottage',
  hearth: 'cottage',
  wilds: 'wilds'
}

/** Each stage's goal: the area, and what to point at there (an NPC, an interactable, or the warden). */
const GOALS: Partial<Record<QuestStage, { area: string; npc?: string; spot?: string; warden?: boolean }>> = {
  new: { area: 'village', npc: 'mara' },
  accepted: { area: 'ruin', spot: 'clue' },
  'clue-found': { area: 'ruin', warden: true, spot: 'clue' },
  'guardian-defeated': { area: 'ruin', spot: 'lantern' },
  'lantern-lit': { area: 'village', npc: 'mara' }
}

/** Steps from `from` to `to` over the road (Infinity when there's no way). */
function steps(from: string, to: string): number {
  if (from === to) return 0
  const seen = new Set([from])
  let frontier = [from]
  for (let d = 1; frontier.length; d++) {
    const next: string[] = []
    for (const a of frontier) {
      for (const b of ROAD[a] ?? []) {
        if (b === to) return d
        if (!seen.has(b)) {
          seen.add(b)
          next.push(b)
        }
      }
    }
    frontier = next
  }
  return Infinity
}

export interface GoalGuideDeps {
  world: WorldData
  /** The quest stage now. */
  stage: () => QuestStage
  /** Live positions: an NPC's sprite, an interactable, the warden (null when absent). */
  npcAt: (id: string) => { x: number; y: number } | null
  spotAt: (id: string) => { x: number; y: number } | null
  wardenAt: () => { x: number; y: number } | null
  /** Whose homestead this is (null: not a homestead), and a guide step's point here. */
  placeKind: () => 'home' | 'cottage' | 'other-home' | 'other-cottage' | null
  guidePoint: (where: GuideWhere) => { x: number; y: number } | null
  /** The pinned guide's current step (null: none pinned, or it's done): the needle follows it instead of the story. */
  pinnedStep: () => { where: GuideWhere | null } | null
  reducedMotion: boolean
}

export class GoalGuide {
  private glow: Phaser.GameObjects.Image
  private chevron: Phaser.GameObjects.Image
  private last: GoalDirPayload = { angle: null, here: false }
  private sent = false
  private t = 0

  constructor(
    private scene: Phaser.Scene,
    private deps: GoalGuideDeps
  ) {
    this.glow = scene.add.image(0, 0, 'glow').setBlendMode(Phaser.BlendModes.ADD).setScrollFactor(0).setDepth(5600).setAlpha(0.8).setVisible(false)
    this.chevron = scene.add.image(0, 0, 'mark-chevron').setScrollFactor(0).setDepth(5601).setVisible(false)
    // Read-only, for playtests: what the guide points at, and whether the edge glint shows.
    if (import.meta.env.DEV) {
      ;(window as unknown as { __fsGoal?: () => unknown }).__fsGoal = () => ({ target: this.target(), dir: this.last, glint: this.glow.visible })
    }
    scene.events.once('shutdown', () => {
      this.glow.destroy()
      this.chevron.destroy()
      bus.emit(EV.goalDir, { angle: null, here: false } satisfies GoalDirPayload)
    })
  }

  /** This scene as a place on the road (ROAD's keys). */
  private place(): string {
    const id = String(this.deps.world.areaId)
    if (id === 'wilds' || id.startsWith('chunk:')) return 'wilds'
    return this.deps.placeKind() ?? id
  }

  /** The point to head for now, in world px, and whether it's the goal itself. */
  target(): { x: number; y: number; here: boolean } | null {
    const step = this.deps.pinnedStep()
    if (step) return step.where ? this.towardGuide(step.where) : null
    const goal = GOALS[this.deps.stage()]
    if (!goal) return null
    const area = this.deps.world.areaId
    if (area === goal.area) {
      const p = (goal.warden ? this.deps.wardenAt() : null) ?? (goal.npc ? this.deps.npcAt(goal.npc) : null) ?? (goal.spot ? this.deps.spotAt(goal.spot) : null)
      return p ? { ...p, here: true } : null
    }
    return this.wayToward(goal.area)
  }

  /** A pinned guide's step: its point when it's here, else the way toward its place. */
  private towardGuide(where: GuideWhere): { x: number; y: number; here: boolean } | null {
    const goal = WHERE_PLACE[where]
    if (this.place() === goal) {
      const p = this.deps.guidePoint(where)
      // In the Wilds (or a point not known yet) there's nothing more exact to point at.
      return p ? { ...p, here: true } : null
    }
    return this.wayToward(goal)
  }

  /** The way out of this place that gets closest to `goal`. */
  private wayToward(goal: string): { x: number; y: number; here: false } | null {
    const from = this.place()
    // Out of the Commons to your own land: your gate on the lane, not an exit.
    if (from === 'commons' && steps('home', goal) < steps('commons', goal)) {
      const g = this.deps.guidePoint('gate')
      if (g) return { ...g, here: false }
    }
    // From your land into the cottage: the door.
    if (from === 'home' && goal === 'cottage') {
      const d = this.deps.guidePoint('door')
      if (d) return { ...d, here: false }
    }
    let best: { x: number; y: number } | null = null
    let bestSteps = Infinity
    for (const e of this.deps.world.exits) {
      const to = String(e.to)
      const node = /^home:\d+$/.test(to) ? (from === 'cottage' ? 'home' : 'other-home') : to.startsWith('chunk:') ? 'wilds' : to
      const n = steps(node, goal)
      if (n < bestSteps) {
        bestSteps = n
        best = { x: (e.tx + e.tw / 2) * TILE, y: (e.ty + e.th / 2) * TILE }
      }
    }
    return best ? { ...best, here: false } : null
  }

  /** Each frame while the world is live (hidden while it isn't: dialogue, panels, cinematics). */
  update(dt: number, hero: { x: number; y: number }, live: boolean): void {
    this.t += dt
    // A panel or a conversation: the glint steps aside, the needle keeps its heading.
    if (!live) {
      this.hide()
      return
    }
    const target = this.target()
    if (!target) {
      this.hide()
      this.emit({ angle: null, here: false })
      return
    }
    const a = Math.atan2(target.y - (hero.y - 8), target.x - hero.x)
    // The needle turns in sixteenths: steady, and the bus stays quiet.
    const step = Math.PI / 8
    this.emit({ angle: Math.round(a / step) * step, here: target.here })
    this.placeGlint(target)
  }

  private emit(p: GoalDirPayload): void {
    if (this.sent && p.angle === this.last.angle && p.here === this.last.here) return
    this.sent = true
    this.last = p
    bus.emit(EV.goalDir, p)
  }

  private hide(): void {
    this.glow.setVisible(false)
    this.chevron.setVisible(false)
  }

  /** On screen: nothing (the world already marks it). Off screen: a glint on the edge of the open area. */
  private placeGlint(target: { x: number; y: number }): void {
    const cam = this.scene.cameras.main
    const z = cam.zoom
    const W = cam.width
    const H = cam.height
    const view = cam.worldView
    // Screen px of the target, and the open rectangle the interface leaves.
    const sx = (target.x - view.x) * z
    const sy = (target.y - view.y) * z
    const m = 22
    const left = playInsets.left + m
    const right = W - playInsets.right - m
    const top = playInsets.top + m
    const bottom = H - playInsets.bottom - m
    if (sx > left && sx < right && sy > top && sy < bottom) {
      this.hide()
      return
    }
    // Where the line from the open area's centre to the target leaves it.
    const cx = (left + right) / 2
    const cy = (top + bottom) / 2
    const a = Math.atan2(sy - cy, sx - cx)
    const hw = Math.max(1, (right - left) / 2)
    const hh = Math.max(1, (bottom - top) / 2)
    const t = Math.min(hw / Math.max(1e-6, Math.abs(Math.cos(a))), hh / Math.max(1e-6, Math.abs(Math.sin(a))))
    const X = cx + Math.cos(a) * t
    const Y = cy + Math.sin(a) * t
    // Scroll-factor-0 objects still zoom about the camera's centre.
    const px = (X - W / 2) / z + W / 2
    const py = (Y - H / 2) / z + H / 2
    const pulse = this.deps.reducedMotion ? 1 : 0.85 + Math.sin(this.t * 4) * 0.15
    this.glow.setPosition(px, py).setScale((0.55 * pulse) / Math.max(1, z / 2)).setVisible(true)
    this.chevron.setPosition(px, py).setRotation(a).setVisible(true)
  }
}
