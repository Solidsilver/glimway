import { homesteadsFor } from '../homestead'
import { homeLights } from '../../lib/homestead-land'
import { lotOrigin } from '../../lib/lots'
/**
 * WorldScene's playtest hooks (docs/playtest.md, src/game/dev-hooks.ts):
 * read-only views of the area, the hero and the systems in it, and the
 * levers playtests pull. Dev builds only; each is deleted when the scene
 * shuts down, and the next build of an area puts its own up.
 *
 * The hooks read the scene's private state through element access
 * (`s['hero']`), which TypeScript still type-checks, so nothing here widens
 * the scene's own interface.
 */
import Phaser from 'phaser'
import type { AreaId } from '../../lib/state'
import { devMainThreadTilesetHash } from '../area/terrain'
import { bus, EV } from '../events'
import { TILE, tileBottom, tileKey } from '../../lib/tile'
import { TILE_DATA } from '../area/tile-art'
import type { EnemyType } from '../worlds'
import { itemsFor } from '../items'
import { isLit as isLandLit } from '../../lib/homestead-land'
import { canvasRatio, playInsets, setPlayInsets } from '../viewport'
import { densityOf } from '../density'
import { syncSafety } from '../sync-safety'
import { expose, type FsHooks } from '../dev-hooks'
import type { PaperPickups } from '../entities/papers'
import type { ItemPickups } from '../entities/item-pickups'
import type { RepairsLayer } from '../entities/repairs'
import type { WorldScene } from './WorldScene'
import { fnv1a32Bytes } from '../../lib/hash'
import { knownPlaces, requestRead, wildsMaterials, wildsView } from '../wilds/store'
import { devFightFall } from '../wilds/dev-fight-fall'
import { presence } from '../presence'
import { pathTileAt } from '../wilds/path-tile'
import { footprintAt } from '../wilds/fixed'
import { chunkOfPixel } from '../wilds/coords'

/** The scene's interaction layers the hooks read (locals of `create()`). */
export interface WorldHookLayers {
  papers: PaperPickups
  pickups: ItemPickups
  repairs: RepairsLayer
}

export function exposeWorldHooks(s: WorldScene, layers: WorldHookLayers): void {
  const on = <K extends keyof FsHooks>(name: K, fn: FsHooks[K]) => expose(name, fn, s)

  on('__fsPapers', () => layers.papers.lying())
  on('__fsOffHand', () => s['offHand']?.showing ?? null)
  on('__fsPickups', () => layers.pickups.ids())
  on('__fsRepairs', () => layers.repairs.ids())

  on('__fsPlayer', () => {
    const b = s['hero'].sprite.body as Phaser.Physics.Arcade.Body
    return {
      x: s['hero'].sprite.x,
      y: s['hero'].sprite.y,
      body: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      blocked: { up: b.blocked.up, down: b.blocked.down, left: b.blocked.left, right: b.blocked.right }
    }
  })
  on('__fsDevShove', (dx, dy) => new Promise((resolve) => {
    s.physics.world.once('worldstep', () => {
      const sprite = s['hero'].sprite
      const body = sprite.body as Phaser.Physics.Arcade.Body
      body.position.x += dx
      body.position.y += dy
      s.events.once('postupdate', () => resolve({ x: sprite.x, y: sprite.y }))
    })
  }))
  on('__fsEnemies', () =>
    s['enemies'].enemies.map((e) => {
      const b = e.sprite.body as Phaser.Physics.Arcade.Body
      return {
        x: e.sprite.x,
        y: e.sprite.y,
        id: e.id,
        fight: e.fight ?? null,
        bodyEnabled: b.enable,
        state: e.state,
        hp: e.hp,
        texture: e.sprite.texture.key,
        frame: e.sprite.frame.name,
        body: { x: b.x, y: b.y, w: Math.round(b.width), h: Math.round(b.height) },
        flipX: e.sprite.flipX,
        type: e.type,
        locked: e.state === 'telegraph' && (e.lungeX !== 0 || e.lungeY !== 0),
        tint: '0x' + e.sprite.tintTopLeft.toString(16).padStart(6, '0')
      }
    })
  )
  on('__fsWarden', () => s['enemies'].warden.wardenView())
  on('__fsWorld', () => {
    const b = s.physics.world.bounds
    const world = s['world']
    return { areaId: world.areaId, widthPx: world.widthPx, heightPx: world.heightPx, bounds: { x: b.x, y: b.y, w: b.width, h: b.height }, solid: world.solid, exits: [...world.exits, ...(s['window']?.exits() ?? [])].map((e) => ({ tx: e.tx, ty: e.ty, tw: e.tw, th: e.th, to: String(e.to), side: e.side, kind: e.kind })) }
  })
  // Is a tile solid in the map's data? (The open map has no grid in __fsWorld: its chunks answer by world tile.)
  on('__fsTileSolid', (tx: number, ty: number) => {
    const world = s['world']
    return world.open ? world.open.solidAt(tx, ty) : world.solid[ty]?.[tx] ?? true
  })
  // Walk through waypoints (world px) as if steered: movement, collisions and the window as in play.
  on('__fsDevWalk', (path: { x: number; y: number }[]) => {
    s['devWalk'] = path.length ? path.map((p) => ({ x: p.x, y: p.y })) : null
  })
  on('__fsDevWalking', () => s['devWalk'] !== null)
  on('__fsDevWalkLeft', () => s['devWalk']?.map((p) => ({ x: p.x, y: p.y })) ?? null)
  // The target as the action button sees it, now or for feet at (x, y).
  on('__fsTarget', (x?: number, y?: number) => {
    const hero = s['hero'].sprite
    const at = x === undefined || y === undefined ? { x: hero.x, y: hero.y } : { x, y }
    return { ...s['interactables'].debugTarget(at, x === undefined || y === undefined), at }
  })
  // The ground under a tile (a TERRAIN id; null where the open map knows nothing).
  on('__fsGroundAt', (tx: number, ty: number) => {
    const world = s['world']
    return world.open ? world.open.groundAt(tx, ty) : world.ground[ty]?.[tx] ?? null
  })
  on('__fsRoom', () => {
    const world = s['world']
    const art = s['roomArt']
    return {
      areaId: world.areaId,
      room: world.room ? { id: world.room.def.id, name: world.room.def.name, arrive: world.room.arrive } : null,
      zoom: s.cameras.main.zoom / canvasRatio(),
      facing: { x: s['hero'].facing.x, y: s['hero'].facing.y },
      props: (world.room?.props ?? []).map((f, i) => ({ art: f.art, frame: String(art?.sprites[i]?.texture.key ?? ''), tx: f.tx, ty: f.ty, tw: f.tw, th: f.th })),
      spots: Object.keys(world.room?.def.spots ?? {}),
      lights: (art?.lights ?? []).map((l) => ({ kind: l.kind, visible: l.image.visible })),
      dressing: (art?.dressing ?? []).map((d) => ({ piece: d.piece.id, depth: d.depth, x: d.foot.x, y: d.foot.y })),
      bodies: s['world'].bodies ?? [],
      houses: s['houseLights']?.view() ?? []
    }
  })
  on('__fsDevCycleCheck', () => s['cycle']?.check())
  on('__fsDevPipWalkOn', () => s['pipWalkOn']?.play() ?? false)

  // How settled this area is, so playtests wait on the game instead of the
  // clock: frames drawn since it was built, the camera fade, and whether
  // world input is live right now.
  const builtAt = s.game.loop.frame
  on('__fsFrame', () => ({
    areaId: s['world'].areaId,
    frames: s.game.loop.frame - builtAt,
    loop: s.game.loop.frame,
    fading: s.cameras.main.fadeEffect.isRunning || s['holdingFade'],
    transitioning: s['transitioning'],
    cinematic: s['cinematic'],
    live: s['worldLive']()
  }))
  // The server revision this tab's link is based on, so a playtest can wait for the link to catch up.
  on('__fsLinkRev', () => s['session'].link?.rev ?? null)
  on('__fsPurse', Object.assign(() => s['session'].link?.purse ?? null, { reread: async () => void (await s['session'].link?.refreshState()) }))
  // Damage through the normal hurt path, so low-health and defeat beats can
  // be checked without a long fight.
  on('__fsDevHurt', (n) => {
    s['hero'].iframes = 0
    s['hero'].damagePlayer(n, s['hero'].sprite.x - 1)
  })
  // The open map's warp goes to a world tile (signed); every other area's to its tile
  // (a fixed place's own, `commons`, onto the grid: its layout tile resolved, src/lib/location.ts).
  on('__fsDevWarp', (area: AreaId, tx: number, ty: number) => (area === 'outdoors' ? s['warpWilds'](tx, ty) : s['transitionTo'](area, { tx, ty })))
  on('__fsDevInsets', (v) => {
    if (v) setPlayInsets(v)
    return { ...playInsets }
  })
  // CSS px: the camera's zoom is in canvas px (canvasRatio of them a CSS px).
  on('__fsDevHeroScreen', () => {
    const cam = s.cameras.main
    const z = cam.zoom / canvasRatio()
    const b = s['hero'].sprite.getBounds()
    return { x: (b.x - cam.worldView.x) * z, y: (b.y - cam.worldView.y) * z, w: b.width * z, h: b.height * z, zoom: z }
  })
  // The camera as drawn (canvas px): its scroll is snapped so (scroll + origin) × zoom is whole (../viewport.ts snapScroll).
  on('__fsDevCamera', () => {
    const cam = s.cameras.main
    return { scrollX: cam.scrollX, scrollY: cam.scrollY, zoom: cam.zoom, originX: cam.width * cam.originX, originY: cam.height * cam.originY }
  })
  on('__fsDevToScreen', (x, y) => {
    const cam = s.cameras.main
    const z = cam.zoom / canvasRatio()
    return { x: (x - cam.worldView.x) * z, y: (y - cam.worldView.y) * z }
  })
  // The world point under the pointer (the pointer is in canvas px).
  on('__fsDevPointerWorld', () => {
    const p = s.input.activePointer
    const at = s.cameras.main.getWorldPoint(p.x, p.y)
    return { x: at.x, y: at.y }
  })
  on('__fsDevAddFlag', (flag) => s['session'].addFlag(flag))
  // e2e/first-paint.spec.ts compares it with the workers' tileset.
  on('__fsDevGroundMainThreadHash', () => {
    const world = s['world']
    if (!world.open) return devMainThreadTilesetHash(s, world)
    const { cx, cy } = chunkOfPixel(s['hero'].sprite.x, s['hero'].sprite.y)
    const fp = footprintAt(cx, cy)
    return fp ? devMainThreadTilesetHash(s, { areaId: fp.place.id, ground: fp.ground, width: fp.w, height: fp.h, scenery: [] }) : Promise.resolve(null)
  })
  // e2e/atlases.spec.ts checks the packed atlases give the loaders the pixels they had.
  on('__fsDevTextureHash', (key) => {
    if (!s.textures.exists(key)) return null
    const src = s.textures.get(key).getSourceImage() as HTMLCanvasElement | HTMLImageElement
    const c = document.createElement('canvas')
    c.width = src.width
    c.height = src.height
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(src, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    return `${c.width}x${c.height}:${fnv1a32Bytes(d).toString(16)}`
  })
  on('__fsDevTextureSize', (key) => {
    if (!s.textures.exists(key)) return null
    const t = s.textures.get(key)
    return { w: t.get().width, h: t.get().height, density: densityOf(t) }
  })
  // `largest`: the biggest side of any texture.
  on('__fsDevTextureMemory', () => {
    const out: Record<string, number> = {}
    let total = 0
    let largest = 0
    for (const key of s.textures.getTextureKeys()) {
      let bytes = 0
      for (const src of s.textures.get(key).source) {
        bytes += src.width * src.height * 4
        largest = Math.max(largest, src.width, src.height)
      }
      out[key] = bytes
      total += bytes
    }
    return { total, largest, textures: out }
  })
  // Frame times for `ms` (e2e/density-screens.spec.ts): the frame-to-frame
  // interval and the game's own step (update and render calls, CPU side).
  // `finish` waits for the GPU at the end of each step, so the step includes
  // the drawing itself (and the gaps grow by the stall).
  on('__fsDevFrameTimes', (ms, finish = false) => {
    const game = s.sys.game
    const gl = finish && game.renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer ? game.renderer.gl : null
    const gaps: number[] = []
    const steps: number[] = []
    let start = 0
    let last = 0
    const pre = () => (start = performance.now())
    const post = () => {
      gl?.finish()
      const now = performance.now()
      steps.push(now - start)
      if (last) gaps.push(now - last)
      last = now
    }
    game.events.on(Phaser.Core.Events.PRE_STEP, pre)
    game.events.on(Phaser.Core.Events.POST_RENDER, post)
    return new Promise((resolve) => {
      setTimeout(() => {
        game.events.off(Phaser.Core.Events.PRE_STEP, pre)
        game.events.off(Phaser.Core.Events.POST_RENDER, post)
        const pct = (a: number[], q: number) => {
          const b = [...a].sort((x, y) => x - y)
          return b.length ? Math.round(b[Math.min(b.length - 1, Math.floor(q * b.length))] * 10) / 10 : 0
        }
        const canvas = game.canvas
        resolve({ frames: gaps.length, gap: { p50: pct(gaps, 0.5), p95: pct(gaps, 0.95) }, step: { p50: pct(steps, 0.5), p95: pct(steps, 0.95) }, canvas: [canvas.width, canvas.height] })
      }, ms)
    })
  })
  // Roll from inside the frame loop, so playtests can react to an aim lock without input latency.
  on('__fsDevDodge', (dx, dy) => s['hero'].tryDodge(new Phaser.Math.Vector2(dx, dy)))
  // One swing of the hero's weapon, wherever they stand (the off hand tucks away).
  on('__fsDevAttack', () => s['hero'].tryAttack())
  // Set the area's creatures aside (frozen, off the map) for a quiet chunk; `keep`: in every later scene too, a reload included.
  on('__fsDevParkCreatures', (keep?: boolean) => s['enemies'].parkAll(keep))
  on('__fsDevStrike', (n: number, type?: EnemyType) => {
    for (const e of [...s['enemies'].enemies]) if (!e.dead && (!type || e.type === type)) s['enemies'].damageEnemy(e, n, s['hero'].sprite.x)
  })
  // A generated camp's fight finished by the dev server (its room's enemies die, the fall is stored with this account as a witness).
  on('__fsDevFightFall', (entity: string) => devFightFall(entity, {
    read: requestRead,
    joined: (cx, cy) => [...(presence()?.fights.rooms.values() ?? [])].some((room) => room.key.cx === cx && room.key.cy === cy)
  }))
  // Without `force`, the real rules apply.
  on('__fsDevSpeakNaming', (force = false) => s['enemies'].warden.speakNaming(force))
  // A playtest can step up to the warden inside its opening. The save's
  // position follows (scene pixels, world pixels on the open map), so an
  // upload's merge never snaps the hero back.
  on('__fsDevPlace', (x, y) => {
    ;(s['hero'].sprite.body as Phaser.Physics.Arcade.Body).reset(x, y)
    s['safeSpot'] = null
    s['fixedSpot'] = null
    s['waitingFixed'] = !s['fixedReady'](x, y)
    s['fixedWait'] = 0
    s['commonsWaitSaid'] = false
    s['notePosition']()
    if (!s['waitingFixed']) s['session'].saveSoon()
  })
  // The stale sample an open conversation leaves behind (playtest 1, Silas's axe).
  on('__fsDevStalePosition', (x, y) => {
    s['session'].state.position = { x: Math.round(x), y: Math.round(y) }
  })
  // So a playtest can make the exit check and the sample meet in one frame (bugs #2).
  on('__fsDevSampleEveryFrame', (every) => {
    s['devSampleEveryFrame'] = every
  })
  // So a playtest can walk into a destination no area kind is registered for (the guard).
  on('__fsDevAddExit', (exit) => {
    s['world'].exits.push({ ...exit, entry: { tx: 1, ty: 1 } })
  })
  // Ask for a save now (the once-a-second position sample doesn't save by itself).
  on('__fsDevSaveSoon', () => s['session'].saveSoon())
  on('__fsDevSaved', () => {
    const session = s['session']
    const timers = session as unknown as { saveTimer: number | null; pendingSave: boolean }
    return { area: session.state.area, position: { ...session.state.position }, pending: timers.saveTimer !== null || timers.pendingSave }
  })
  // An `action` (draw water at the well) goes through as such.
  on('__fsDevUseTool', async (instance, n = 1, action) => {
    let last: unknown = null
    for (let i = 0; i < n; i++) {
      const r = await itemsFor(s['session']).useTool(instance, action)
      if (!r.ok) return { error: r.code }
      last = r.value.wear
    }
    return last
  })

  on('__fsItems', Object.assign(() => itemsFor(s['session']).view, { load: () => itemsFor(s['session']).load() }))
  on('__fsVitals', () => {
    const st = s['session'].state
    return { hp: st.hp, maxHp: st.maxHp, mana: st.mana, maxMana: st.maxMana }
  })
  on('__fsLink', () => s['session'].link?.status ?? null)
  on('__fsWilds', () => s['wilds']?.debug() ?? null)
  // The open map's window: what's attached, drifted, fetched, and how long each chunk took to paint.
  on('__fsWildsWindow', () => s['window']?.debug() ?? null)
  // How much the scene holds: a leak (a tween left running, an image never removed) shows as growth.
  on('__fsSceneSize', () => {
    const kinds: Record<string, number> = {}
    for (const o of s.children.list) {
      const k = `${o.type}:${(o as { texture?: { key: string } }).texture?.key ?? ''}`
      kinds[k] = (kinds[k] ?? 0) + 1
    }
    const tweens = s.tweens.getTweens()
    // Textures the scene's chunks made (ground paints, drift), and everything listening on the game's bus.
    const textures = s.textures.getTextureKeys().filter((k) => /^wilds-(ground|drift):/.test(k)).length
    const listeners = Object.values(EV).reduce((n, e) => n + bus.listenerCount(e), 0)
    return { list: s.children.length, tweens: tweens.length, transientTweens: tweens.filter(t => !t.isInfinite).length, statics: s.physics.world.staticBodies.size, textures, listeners, kinds }
  })
  on('__fsPaths', () => {
    const paths = s['paths']
    if (!paths) return null
    const view = wildsView()
    const ways = [...(view?.ways.values() ?? [])].map((w) => ({ id: w.id, name: w.name, a: w.a, b: w.b, by: w.by, signA: w.signA ? { x: w.signA.x, y: w.signA.y } : null, signB: w.signB ? { x: w.signB.x, y: w.signB.y } : null, path: w.path.length }))
    return { ...paths.debug(), materials: wildsMaterials(), ways }
  })
  on('__fsPathTile', (tx: number, ty: number) => pathTileAt(tx, ty))
  on('__fsMarks', () => {
    const marks = s['marks']
    if (!marks) return null
    const view = wildsView()
    return { ...marks.debug(), discoveries: [...(view?.discoveries.values() ?? [])].map((d) => ({ id: d.entityId, by: d.discovererId, name: d.displayName })), places: knownPlaces() }
  })
  on('__fsRumour', () => {
    const link = s['session'].link
    // `current`: read since the last turning (Link.rumourStale), so it's this wick's.
    return link?.rumour ? { ...link.rumour, current: !link.rumourStale } : null
  })
  // Playtests of the drift rule.
  on('__fsGather', () => {
    const gathering = s['gathering']
    if (!gathering) return null
    const mine = homesteadsFor(s['session']).mine
    const origin = mine ? lotOrigin(mine.gate) : { tx: 0, ty: 0 }
    const lights = mine ? homeLights(mine.items.filter((i) => i.scene === 'outdoor' && i.itemDef === 'lantern-post' && i.x !== null && i.y !== null) as { x: number; y: number }[]).map((l) => ({ ...l, x: l.x + origin.tx, y: l.y + origin.ty })) : []
    return {
      area: s['world'].areaId,
      spots: gathering.spotsView().map((p) => ({ ...p, lit: isLandLit(lights, p.tx, p.ty) })),
      prompt: gathering.prompted(),
      left: gathering.leftView(),
      last: gathering.lastOutcome(),
      lights,
      hint: gathering.hinted(),
      hintSettled: gathering.hintSettled()
    }
  })
  // Playtests of fishing (crafts.md 5): the line, the landed fish, the bands read.
  on('__fsFishing', () => s['fishing']?.view() ?? null)
  // A broken rock leaves no invisible wall.
  on('__fsSolidAt', (tx, ty) =>
    s['solids'].group.getChildren().some((c) => {
      const b = (c as Phaser.Physics.Arcade.Image).body as Phaser.Physics.Arcade.StaticBody | null
      return !!b && b.x < (tx + 1) * TILE && b.right > tx * TILE && b.y < tileBottom(ty) && b.bottom > ty * TILE
    })
  )
  on('__fsArtAt', (tx, ty) => {
    const fading = new Set(s['occluders'].map((o) => o.image))
    return s.children.list
      .filter((c): c is Phaser.GameObjects.Image => c instanceof Phaser.GameObjects.Image && c.active && c.getData(TILE_DATA) === tileKey(tx, ty))
      .map((c) => ({ frame: String(c.frame.name), fades: fading.has(c) }))
  })
  on('__fsSafety', syncSafety)
  // Seated: the seat's pose and the depths drawn at (the hero's and the
  // layered avatar's), so a playtest can check the hero sits on the seat.
  on('__fsSeat', () => {
    const hero = s['hero']
    const avatar = s['avatar']
    return {
      seated: hero.isSeated,
      bonus: hero.seatedBonus,
      mana: Math.floor(s['session'].state.mana),
      maxMana: s['session'].state.maxMana,
      x: hero.sprite.x,
      y: hero.sprite.y,
      seat: hero.seat ? { x: hero.seat.x, y: hero.seat.y, depth: hero.seat.depth, facing: hero.seat.facing } : null,
      heroDepth: hero.sprite.depth,
      heroScale: { x: hero.sprite.scaleX, y: hero.sprite.scaleY },
      heroCrop: hero.sprite.isCropped,
      avatar: avatar.container
        ? { x: avatar.container.x, y: avatar.container.y, depth: avatar.container.depth, scaleX: avatar.container.scaleX, scaleY: avatar.container.scaleY, ...avatar.pose }
        : null
    }
  })
  on('__fsDebug', () => {
    const hero = s['hero']
    const avatar = s['avatar']
    const projectiles = s['projectiles']
    const keys = s['controls'].keys
    const cursors = s['controls'].cursors
    return {
      avatar: !!avatar.container,
      /** What the layered avatar is drawn holding ('' = its own weapon). */
      holding: avatar.holding,
      /** The directional held frame drawn ('' = none, or the item's icon). */
      holdingFrame: avatar.holdingFrame,
      pet: !!avatar.pet,
      /** The sprite names the hero is drawn from (0.6: the wardrobe's look shows here). */
      layers: avatar.drawn,
      riding: avatar.riding,
      /** Crafts (0.5): the follower drawn (its pose), the mount that's out and whether it's on the lead. */
      follower: avatar.follower ? { pose: avatar.follower.pose, x: Math.round(avatar.follower.x), y: Math.round(avatar.follower.y) } : null,
      mountOut: avatar.mountOut,
      led: avatar.led ? { key: avatar.led.key, drawn: avatar.led.drawn } : null,
      /** The last mount Go home sent: where it is (or last was), its bay's floor (null: off the screen), and whether it's gone. */
      walkingHome: avatar.walkingHome ? { key: avatar.walkingHome.key, x: Math.round(avatar.walkingHome.state.x), y: Math.round(avatar.walkingHome.state.y), bay: avatar.walkingHome.bay, done: avatar.walkingHome.done } : null,
      playerAlpha: hero.sprite.alpha,
      playerVisible: hero.sprite.visible,
      bolts: projectiles ? projectiles.length : -1,
      attackCooldown: hero.attackCooldown,
      castCooldown: hero.castCooldown,
      facing: { x: hero.facing.x, y: hero.facing.y },
      heroTex: hero.sprite.texture.key,
      npcs: s['npcs'].npcs.map((n) => ({
        id: n.id,
        texture: n.sprite.texture.key,
        anim: n.sprite instanceof Phaser.GameObjects.Sprite ? n.sprite.anims.currentAnim?.key ?? null : null
      })),
      keys: {
        left: cursors.left.isDown,
        right: cursors.right.isDown,
        up: cursors.up.isDown,
        down: cursors.down.isDown,
        E: keys.E.isDown,
        F: keys.F.isDown
      },
      keyboardEnabled: s.input.keyboard?.enabled ?? null,
      keyboardActive: (s.input.keyboard as unknown as { isActive?: () => boolean }).isActive?.() ?? null,
      body: (() => {
        const b = hero.sprite.body as Phaser.Physics.Arcade.Body
        return { vx: b.velocity.x, vy: b.velocity.y, moves: b.moves, enable: b.enable, physicsPaused: s.physics.world.isPaused }
      })(),
      unmoored: s['unmoored'].now().active
    }
  })
  // Untyped on purpose: specs send any event by its wire name.
  on('__fsEmit', (event, ...args) => (bus.emit as (name: string, ...a: unknown[]) => boolean)(event, ...args))
  on('__fsUnmoored', (val) => {
    if (typeof val === 'boolean') s['unmoored'].set(val)
    return s['unmoored'].now().active
  })
  on('fsUnmoored', {
    trigger: () => s['unmoored'].trigger(),
    clear: () => s['unmoored'].clear()
  })
}
