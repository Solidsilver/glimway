/**
 * Remote players — other people in your world, drawn from the presence feed
 * (src/game/presence.ts). WorldScene owns one instance per area and ticks it
 * every frame, even while a panel or dialogue holds the screen, so peers keep
 * walking around you.
 *
 * Each peer is their Habitica avatar (the same layer stack as the hero, via
 * avatar-render's loadPresenceAvatar) or, until it loads or without one, the
 * walking demo hero; a name tag; and a soft shadow. Positions are
 * interpolated (src/lib/presence-interp.ts), facing flips the body, walking
 * bobs it (the demo hero plays its walk cycle), and peers fade in on arrival
 * and out on leaving. They have no physics body: they never collide with or
 * block the hero, and nothing about them affects gameplay.
 *
 * Emote bubbles (`showEmoteBubble`) are shared with the hero's own emotes.
 */
import type Phaser from 'phaser'
import { loadPresenceAvatar } from '../avatar-render'
import { bus, EV, type EmotePayload } from '../events'
import { emoteSay } from '../../content/presence'
import { LEAVE_FADE_MS, type Peer, type PresenceFeed } from '../presence'
import { expose } from '../dev-hooks'

/** Habitica sprite grid (source px) and its on-screen height (as the hero's avatar). */
const AVATAR_CANVAS = 90
const AVATAR_DISPLAY = 22
const FADE_IN_MS = 400
const BUBBLE_MS = 2600

export interface RemotePlayers {
  /** Per-frame update (interpolation, walk bob, fades, depth-by-y). */
  update(dt: number): void
  /** Drop every remote sprite (area change, scene shutdown). */
  clear(): void
}

class NoopRemotePlayers implements RemotePlayers {
  update(_dt: number): void {}
  clear(): void {}
}

/** One drawn peer. */
interface View {
  peer: Peer
  root: Phaser.GameObjects.Container
  body: Phaser.GameObjects.Container
  demo: Phaser.GameObjects.Sprite | null
  tag: Phaser.GameObjects.Text
  bubble: Phaser.GameObjects.Container | null
  bubbleText: string | null
  bornAt: number
  facingX: 1 | -1
  moving: boolean
}

const now = () => performance.now()

/**
 * A speech bubble over a game object (a peer's root, or the hero's sprite),
 * following it until it fades. Returns the bubble so a newer one can replace it.
 */
export function showEmoteBubble(
  scene: Phaser.Scene,
  follow: { x: number; y: number },
  emoteId: string,
  offsetY = -30
): Phaser.GameObjects.Container {
  const say = emoteSay(emoteId)
  const text = scene.add.text(0, 0, say, {
    fontFamily: '"Pixelify Sans", monospace',
    fontSize: '8px',
    color: '#3b2a1e',
    resolution: 8
  }).setOrigin(0.5, 0.5)
  const w = Math.ceil(text.width) + 8
  const h = Math.ceil(text.height) + 4
  const g = scene.add.graphics()
  g.fillStyle(0x2b1d1a, 1).fillRoundedRect(-w / 2 - 1, -h / 2 - 1, w + 2, h + 2, 4)
  g.fillStyle(0xfbf1da, 1).fillRoundedRect(-w / 2, -h / 2, w, h, 3)
  // Tail toward the speaker.
  g.fillStyle(0x2b1d1a, 1).fillTriangle(-3, h / 2, 3, h / 2, 0, h / 2 + 4)
  g.fillStyle(0xfbf1da, 1).fillTriangle(-2, h / 2 - 1, 2, h / 2 - 1, 0, h / 2 + 2)
  const bubble = scene.add.container(follow.x, follow.y + offsetY, [g, text]).setDepth(9000).setAlpha(0)
  bubble.setData('emote', emoteId)
  bubble.setData('say', say)
  scene.tweens.add({ targets: bubble, alpha: 1, y: bubble.y - 3, duration: 160, ease: 'Quad.easeOut' })
  const tick = () => {
    if (!bubble.active) return
    bubble.setPosition(follow.x, follow.y + offsetY - 3)
  }
  scene.events.on('postupdate', tick)
  scene.time.delayedCall(BUBBLE_MS, () => {
    if (!bubble.active) return
    scene.tweens.add({
      targets: bubble,
      alpha: 0,
      duration: 260,
      onComplete: () => {
        scene.events.off('postupdate', tick)
        bubble.destroy()
      }
    })
  })
  bubble.once('destroy', () => scene.events.off('postupdate', tick))
  return bubble
}

class RemotePlayersLayer implements RemotePlayers {
  private views = new Map<string, View>()
  private destroyed = false
  private readonly onEmote = (p: EmotePayload) => {
    if (!p.habiticaId) return
    const v = this.views.get(p.habiticaId)
    if (!v) return
    v.bubble?.destroy()
    // Above the name tag, which stays readable under it.
    const b = p.id === 'heart' ? showHeart(this.scene, v.root, -AVATAR_DISPLAY - 13) : showEmoteBubble(this.scene, v.root, p.id, -AVATAR_DISPLAY - 21)
    v.bubble = b
    v.bubbleText = p.id === 'heart' ? '' : emoteSay(p.id)
    b.once('destroy', () => {
      if (v.bubble !== b) return
      v.bubble = null
      v.bubbleText = null
    })
  }

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly feed: PresenceFeed,
    private readonly area: string
  ) {
    bus.on(EV.emote, this.onEmote)
    expose('__fsRemote', () =>
      [...this.views.values()].map((v) => ({
        id: v.peer.habiticaId,
        name: v.peer.displayName,
        x: Math.round(v.root.x),
        y: Math.round(v.root.y),
        alpha: v.root.alpha,
        moving: v.moving,
        avatar: v.demo === null,
        bubble: v.bubble?.active ? v.bubbleText : null
      })),
      scene
    )
  }

  update(_dt: number): void {
    if (this.destroyed) return
    const t = now()
    const seen = new Set<string>()
    for (const peer of this.feed.peersIn(this.area)) {
      const at = peer.track.at(t)
      if (!at) continue
      seen.add(peer.habiticaId)
      let v = this.views.get(peer.habiticaId)
      if (!v) {
        if (peer.leftAt !== null) continue // never seen, already gone
        v = this.create(peer, at.x, at.y)
      }
      v.peer = peer
      v.root.setPosition(at.x, at.y)
      v.root.setDepth(at.y + 0.5)
      if (Math.abs(at.facing.x) > 0.2) v.facingX = at.facing.x < 0 ? -1 : 1
      v.moving = at.moving
      this.animate(v, at.facing, t)
      // Fade in on arrival, out on leaving.
      const alphaIn = Math.min(1, (t - v.bornAt) / FADE_IN_MS)
      const alphaOut = peer.leftAt === null ? 1 : Math.max(0, 1 - (t - peer.leftAt) / LEAVE_FADE_MS)
      v.root.setAlpha(Math.min(alphaIn, alphaOut))
      if (peer.leftAt !== null && alphaOut <= 0) {
        this.drop(peer.habiticaId)
        continue
      }
      if (v.peer.displayName !== v.tag.text) v.tag.setText(v.peer.displayName)
    }
    for (const id of [...this.views.keys()]) if (!seen.has(id)) this.drop(id)
  }

  clear(): void {
    this.destroyed = true
    bus.off(EV.emote, this.onEmote)
    for (const id of [...this.views.keys()]) this.drop(id)
  }

  private create(peer: Peer, x: number, y: number): View {
    const scene = this.scene
    const shadow = scene.add.image(0, -1, 'shadow').setAlpha(0.3)
    const body = scene.add.container(0, 0)
    // Stand-in until (or unless) the Habitica layers load: the walking demo hero.
    let demo: Phaser.GameObjects.Sprite | null = null
    const tex = scene.textures.exists('fingersnap-demo-walk') ? scene.textures.get('fingersnap-demo-walk') : null
    const frame = tex?.has('walk-down-0') ? tex.get('walk-down-0') : null
    if (frame) {
      demo = scene.add.sprite(0, 0, 'fingersnap-demo-walk', 'walk-down-0').setOrigin(0.5, 1).setScale(20 / frame.height)
    } else {
      demo = scene.add.sprite(0, 0, 'hero0').setOrigin(0.5, 1)
    }
    body.add(demo)
    const tag = scene.add.text(0, -AVATAR_DISPLAY - 6, peer.displayName, {
      fontFamily: '"Pixelify Sans", monospace',
      fontSize: '7px',
      color: '#fff3c4',
      stroke: '#241f31',
      strokeThickness: 3,
      resolution: 8
    }).setOrigin(0.5, 1)
    const root = scene.add.container(x, y, [shadow, body, tag]).setAlpha(0).setDepth(y + 0.5)
    const view: View = { peer, root, body, demo, tag, bubble: null, bubbleText: null, bornAt: now(), facingX: 1, moving: false }
    this.views.set(peer.habiticaId, view)
    if (peer.avatar) void this.loadAvatar(view, peer)
    return view
  }

  /** Swap the stand-in for the Habitica layers once they load (if any do). */
  private async loadAvatar(view: View, peer: Peer): Promise<void> {
    const keys = await loadPresenceAvatar(this.scene, peer.avatar!)
    if (this.destroyed || this.views.get(peer.habiticaId) !== view || keys.length === 0 || !view.root.active) return
    const scale = AVATAR_DISPLAY / AVATAR_CANVAS
    const images = keys.map((k) => this.scene.add.image(0, -AVATAR_DISPLAY / 2, k).setOrigin(0.5, 0.5).setScale(scale))
    view.demo?.destroy()
    view.demo = null
    view.body.removeAll(true)
    view.body.add(images)
  }

  /** Facing, and the walk: the demo hero's cycle, or a step bob for avatars. */
  private animate(v: View, facing: { x: number; y: number }, t: number): void {
    if (v.demo) {
      if (v.moving) {
        const anim = Math.abs(facing.x) >= Math.abs(facing.y)
          ? facing.x < 0 ? 'demo-walk-left' : 'demo-walk-right'
          : facing.y < 0 ? 'demo-walk-up' : 'demo-walk-down'
        if (this.scene.anims.exists(anim) && v.demo.anims.currentAnim?.key !== anim) v.demo.play(anim, true)
      } else if (v.demo.anims.isPlaying) {
        v.demo.anims.stop()
      }
      v.body.setY(0)
      return
    }
    v.body.setScale(v.facingX, 1)
    const bob = v.moving ? -Math.abs(Math.sin(t * 0.016)) * 1.6 : Math.sin(t * 0.004) * 0.6
    v.body.setY(bob)
  }

  private drop(id: string): void {
    const v = this.views.get(id)
    if (!v) return
    v.bubble?.destroy()
    v.root.destroy()
    this.views.delete(id)
  }
}

/** Wordless maker's mark: a small pixel heart above the maker. */
function showHeart(scene: Phaser.Scene, follow: { x: number; y: number }, offsetY: number): Phaser.GameObjects.Container {
  const g = scene.add.graphics()
  g.fillStyle(0xc94b59, 1)
  g.fillRect(-5, -3, 4, 4).fillRect(1, -3, 4, 4)
  g.fillRect(-7, -1, 14, 4).fillRect(-5, 3, 10, 3).fillRect(-3, 6, 6, 2)
  const heart = scene.add.container(follow.x, follow.y + offsetY, [g]).setDepth(9000).setAlpha(0)
  scene.tweens.add({ targets: heart, alpha: 1, y: heart.y - 3, duration: 160, ease: 'Quad.easeOut' })
  const tick = () => {
    if (heart.active) heart.setPosition(follow.x, follow.y + offsetY - 3)
  }
  scene.events.on('postupdate', tick)
  scene.time.delayedCall(BUBBLE_MS, () => {
    if (heart.active) scene.tweens.add({ targets: heart, alpha: 0, duration: 260, onComplete: () => { scene.events.off('postupdate', tick); heart.destroy() } })
  })
  heart.once('destroy', () => scene.events.off('postupdate', tick))
  return heart
}

/**
 * The scene hands itself in. `area` is the presence room (null: none here),
 * and `hidden` skips drawing (inside a cottage, where map coordinates differ).
 */
export function createRemotePlayers(scene: Phaser.Scene, feed: PresenceFeed | null, area: string | null, hidden = false): RemotePlayers {
  if (!feed || !area || hidden) return new NoopRemotePlayers()
  return new RemotePlayersLayer(scene, feed, area)
}
