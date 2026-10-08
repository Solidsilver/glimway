/**
 * What a conversation's chosen action does once the dialogue closes
 * (DialogueChoice.action): a table from the action's prefix to its handler.
 *
 * Most handlers are a server write: `withServer` sends where the hero
 * stands along with it (the server measures reach from there), drops the
 * answer if the scene has gone meanwhile, and says a refusal in a toast
 * unless the handler says it another way. Ember spends (rest, the chest, a
 * road lantern) are the rest: the server's for connected play, the save's
 * for guests, with one table of refusal words (src/content/errors.ts).
 *
 * A new kind of action is one row in `routes`.
 */
import Phaser from 'phaser'
import { itemInfo } from '../../content/world'
import { echoCampSpeaker, echoForKeepsake } from '../../content/echoes'
import { foundToast, paperById } from '../../content/papers'
import { ADA_OIL_REPLIES, HEIRLOOMS, HEIRLOOM_IDS, countAdaOilGifts, type HeirloomId } from '../../content/heirlooms'
import { spendErrorText } from '../../content/errors'
import { CHARM_ITEM, ROAD_LANTERNS, type EmberSpend, type RoadLanternId } from '../../lib/embers'
import { yieldLine } from '../../lib/gathering'
import { sellerFor } from '../../lib/items'
import { echoSettled } from '../../lib/wilds/stories'
import { TILE, tileMid } from '../../lib/tile'
import { refreshLanternVisuals, type LightProp } from '../area/lanterns'
import { openDialogue } from '../dialogue'
import { bus, EV } from '../events'
import { heirloomBeat, sayHeirloomRefusal } from '../heirloom-beats'
import { itemsFor } from '../items'
import type { Result } from '../../lib/api/errors'
import { keepsakeSpeaker, keepsakeThanks, parseKeepsakeAction } from '../keepsakes'
import { emitResidents } from '../residents'
import { sfx } from '../sfx'
import type { Session } from '../session'
import type { WorldData } from '../worlds'
import type { Effects } from '../entities/fx'
import type { Hero } from '../entities/hero'
import type { HomesteadLayer } from '../entities/homesteads'
import type { WildsEntities } from '../wilds/entities'

export interface WorldActionDeps {
  scene: Phaser.Scene
  session: Session
  world: WorldData
  fx: Effects
  hero: () => Hero
  lightProps: () => LightProp[]
  homesteads: () => HomesteadLayer | null
  wilds: () => WildsEntities | null
  /** Write where the hero stands into the save (it rides along with a write). */
  notePosition: () => void
  /** A paid outcome changes what the markers and the prompt say. */
  refresh: () => void
}

/** An action's prefix, and its handler (given the rest after the prefix, and the whole action). */
type Route = [prefix: string, handle: (rest: string, action: string) => void]

export class WorldActions {
  private readonly routes: Route[] = [
    ['home:', (_rest, action) => void this.deps.homesteads()?.onAction(action)],
    [
      'keep:return:',
      (_rest, action) => {
        const parsed = parseKeepsakeAction(action)
        if (parsed) this.returnKeepsake(parsed.def, parsed.target)
      }
    ],
    // A settle picked in an Echo camp conversation (the keep's offer keeps the lamp open).
    ['echo:settle:', (siteId) => void this.deps.wilds()?.settleEcho(siteId)],
    ['heirloom:grant:', (id) => this.grantHeirloom(id)],
    [
      'buy:',
      (rest) => {
        const [seller, good] = rest.split(':')
        if (seller && good) this.marketBuy(seller, good)
      }
    ]
  ]

  constructor(private deps: WorldActionDeps) {}

  /** Do what the chosen line said. */
  apply(action: string): void {
    if (action === 'ada:oil') return this.giveAdaOil()
    const route = this.routes.find(([prefix]) => action.startsWith(prefix))
    if (route) return route[1](action.slice(route[0].length), action)
    const spend = spendFor(action)
    if (spend) this.spend(spend)
  }

  /**
   * A server write picked in a conversation (connected play only): the
   * hero's spot rides along, an answer for a scene that has gone is
   * dropped, and a refusal is a toast unless `refused` says it otherwise.
   */
  private withServer<T>(call: () => Promise<Result<T>>, ok: (value: T) => void, refused?: (code: string) => void): void {
    if (!this.deps.session.link) return
    this.deps.notePosition()
    void call().then((r) => {
      if (!this.deps.scene.sys.isActive()) return
      if (r.ok) ok(r.value)
      else if (refused) refused(r.code)
      else bus.emit(EV.toast, { text: r.text, kind: 'error' })
    })
  }

  /**
   * A keepsake given back at the end of a conversation (docs/items/
   * overview.md, "Returning keepsakes"): the thanks wait for the server's
   * yes, and a refusal leaves the keepsake with you and says so. On a yes
   * the resident speaks their thanks and the paper's own toast marks the find.
   */
  private returnKeepsake(def: string, target: string): void {
    this.withServer(
      () => itemsFor(this.deps.session).returnKeepsake(def, target),
      (value) => {
        const returned = value.returned ?? def
        const thanks = keepsakeThanks(returned)
        if (thanks.length) {
          openDialogue({ id: 'keep-return', speaker: keepsakeSpeaker(target), lines: thanks }, { sound: null })
        } else {
          // A keep with no living owner, left at its Echo camp: the echo
          // answers in its own register (the camp's voice once settled).
          const left = echoForKeepsake(returned)
          if (left) {
            openDialogue(
              {
                id: 'echo-keepsake-left',
                speaker: echoCampSpeaker(left.echo.member, echoSettled(this.deps.session.state.flags, left.echo.member)),
                lines: [...left.keep.leave]
              },
              { sound: null }
            )
            emitResidents(this.deps.session)
          }
        }
        if (value.paper) {
          const paper = paperById(value.paper)
          if (paper) bus.emit(EV.toast, { text: foundToast(paper), icon: 'scroll', kind: 'gain', gain: { to: 'journal', label: paper.title } })
        }
      }
    )
  }

  /** An heirloom handed over; a refusal is the giver's own words, in the conversation. */
  private grantHeirloom(id: string): void {
    if (!(HEIRLOOM_IDS as readonly string[]).includes(id)) return
    this.withServer(
      () => itemsFor(this.deps.session).grantHeirloom(id),
      () => {
        const h = HEIRLOOMS[id as HeirloomId]
        if (h) bus.emit(EV.toast, { text: h.toast, icon: 'bag', kind: 'gain', gain: { to: 'bag', itemDef: h.id, qty: 1 } })
        emitResidents(this.deps.session)
      },
      (code) => sayHeirloomRefusal(id as HeirloomId, code)
    )
  }

  /** Buying from a seller (a resident's kitchen door, or the day's market stall). */
  private marketBuy(seller: string, good: string): void {
    this.withServer(
      () => itemsFor(this.deps.session).buy(seller, good),
      (value) => {
        // The seller's own words for what changed hands.
        const bought = value.bought
        if (!bought) return
        const line = sellerFor(bought.seller)?.goods.find((g) => g.item === bought.itemDef)?.line
        bus.emit(EV.toast, { text: line ?? `Bought: ${yieldLine([{ itemDef: bought.itemDef, qty: bought.qty }])}.`, icon: 'bag', art: `icon-${bought.itemDef}` })
      }
    )
  }

  /** Hearth oil for Ada's window; the third flask brings her spade. */
  private giveAdaOil(): void {
    this.withServer(
      () => itemsFor(this.deps.session).giveAdaOil(),
      (value) => {
        const count = value.adaOilCount ?? countAdaOilGifts(this.deps.session.state.flags)
        if (count >= 3) {
          // The third flask: the spade, offered only if it can be handed over now.
          const beat = heirloomBeat(this.deps.session, 'ada-garden-spade', 'Take Ada’s garden spade')
          if (beat) {
            openDialogue(
              {
                id: 'ada-spade-grant',
                speaker: HEIRLOOMS['ada-garden-spade'].speaker,
                lines: beat.lines,
                choices: beat.choices.length ? [...beat.choices, { text: 'Not yet' }] : undefined
              },
              { sound: null }
            )
          }
        } else {
          const reply = ADA_OIL_REPLIES[count] ?? ['Good oil for the window. Thank you.']
          openDialogue({ id: 'ada-oil-thanks', speaker: 'Ada', lines: [...reply] }, { sound: null })
        }
      }
    )
  }

  /**
   * An ember spend. Connected play: the server decides; the world waits
   * (persistenceInFlight), the payoff plays only after a yes, and nothing
   * changes on a no. Guests spend from the save.
   */
  private spend(spend: EmberSpend): void {
    const { session, scene } = this.deps
    const refused = (code: string) => bus.emit(EV.toast, { text: spendErrorText(code), kind: 'error' })
    if (session.link) {
      void session.link.spend(spend).then((result) => {
        if (!scene.sys.isActive()) return
        if (result === null) this.payoff(spend)
        else refused(result)
      })
      return
    }
    const result = session.spend(spend)
    // A guest's spend is refused as busy while a Habitica sync owns the save.
    if (result) refused(result === 'busy' ? 'syncing' : result)
    else this.payoff(spend)
  }

  /** The visible reward for a spend that went through. */
  private payoff(spend: EmberSpend): void {
    const { scene, session, fx } = this.deps
    const hero = this.deps.hero().sprite
    sfx('lantern')
    if (spend.kind === 'rest' || spend.kind === 'home-rest') {
      hero.setTint(0xffe2a8)
      scene.time.delayedCall(260, () => hero.clearTint())
      fx.sparkBurst(hero.x, hero.y - 10, 10)
      fx.floatText(hero.x, hero.y - 24, 'Rested', '#ffd27a', false)
      bus.emit(EV.toast, {
        text: spend.kind === 'home-rest' ? 'Home, and rested. Health and mana restored.' : 'Warm and rested. Health and mana restored.',
        icon: 'ember'
      })
    } else if (spend.kind === 'road-lantern') {
      const lights = this.deps.lightProps()
      const lp = lights.find((l) => l.id === spend.id)
      refreshLanternVisuals(scene, lights, session.questStage, session.state)
      if (lp) {
        const bloom = scene.add.image(lp.gx, lp.gy, 'glow').setBlendMode(Phaser.BlendModes.ADD).setDepth(4002).setScale(0.2)
        scene.tweens.add({ targets: bloom, scale: 2.4, alpha: 0, duration: 900, ease: 'Quad.easeOut', onComplete: () => bloom.destroy() })
        fx.sparkBurst(lp.gx, lp.gy, 10)
      }
      bus.emit(EV.toast, { text: 'The road lantern is lit. Rest in its light to recover.', icon: 'lantern' })
    } else {
      const spot = this.deps.world.emberSpots.find((e) => e.id === 'chest')
      if (spot) fx.sparkBurst(tileMid(spot.tx), spot.ty * TILE + 6, 14)
      bus.emit(EV.toast, { text: `Found: ${itemInfo(CHARM_ITEM).name}. Your strikes find the gaps more often.`, icon: 'ember' })
    }
    this.deps.refresh()
  }
}

/** The ember spend an action names (rest, home-rest, chest, light:<road lantern>), if any. */
function spendFor(action: string): EmberSpend | null {
  if (action === 'rest') return { kind: 'rest' }
  if (action === 'home-rest') return { kind: 'home-rest' }
  if (action === 'chest') return { kind: 'chest' }
  const lantern = action.startsWith('light:') ? action.slice('light:'.length) : null
  if (lantern && (ROAD_LANTERNS as readonly string[]).includes(lantern)) return { kind: 'road-lantern', id: lantern as RoadLanternId }
  return null
}
