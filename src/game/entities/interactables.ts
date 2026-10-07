/**
 * Interactables: the interaction points derived from WorldData (NPCs, the
 * clue, the shrine lantern, ember spots — plus the found-text pickups and
 * library door owned by ./papers), their floating "!" / "…" markers
 * and keycap hint, the proximity prompt (recomputed every frame so the
 * wording follows quest progress), and opening conversations.
 */
import type Phaser from 'phaser'
import { dialogueFor, emberDialogue, type Dialogue, type DialogueChoice } from '../../content/world'
import { EMBER_COSTS, isLit, ROAD_LANTERNS, type EmberSpend, type RoadLanternId } from '../../lib/embers'
import { ITEMS } from '../../lib/items'
import { bus, EV, type PromptPayload } from '../events'
import { uiState } from '../input'
import { sfx } from '../sfx'
import { isTouchFirst } from '../../ui/device'
import type { Session } from '../session'
import { TILE } from '../textures'
import type { EmberSpotId, InteractId, WorldData } from '../worlds'
import { NPC_NAMES } from './npcs'
import { handoverFor } from '../../content/papers'
import { isResident, metAt, residentFullName, residentTalk, type ResidentId } from '../../content/residents'
import { shortTalk } from '../../content/talk'
import { greetingFor, heardDay, heardStory, markDay, markStory } from '../heard'
import { meetResident, residentContext } from '../residents'
import { itemsFor } from '../items'
import { keepsakeAsk } from '../keepsakes'
import { VILLAGE_EV, villageFor, type Village } from '../village'
import { HOME_EV } from '../homestead'
import { HEIRLOOM_GUEST_LINES, NORTH_BRIDGE_DONE, countAdaOilGifts } from '../../content/heirlooms'
import { heirloomBeat } from '../heirloom-beats'
import type { PaperPickups } from './papers'

export interface Interactable {
  id: InteractId
  x: number
  y: number
  label: string
}

/** A non-dialogue action the interact key does right now, and where to hint it. */
export interface PromptAction {
  label: string
  /** Short word for the touch action button. */
  verb: string
  x: number
  y: number
}

/**
 * A feature that owns some interaction points and changes them at runtime
 * (the homesteads: Silas, signs, doors, the bedroll). It answers for its own
 * ids; the list itself is pushed with `Interactables.setDynamic`.
 */
export interface InteractionProvider {
  owns(id: InteractId): boolean
  activate(id: InteractId): void
  label?(id: InteractId): string | null
  marker?(id: InteractId): 'quest' | 'talk' | null
  markerOffset?(id: InteractId): number | null
  /** Short word for the touch action button. */
  verb?(id: InteractId): string | null
}

export interface InteractableDeps {
  world: WorldData
  session: Session
  reducedMotion: boolean
  /** Found-text pickups and the library door (they handle their own interactions). */
  papers?: PaperPickups
  /** Runtime interaction points owned by features (homesteads, village life). */
  extras?: InteractionProvider[]
  village?: Village
}

/**
 * Has this person something you haven't heard? Their story at this stage
 * (src/game/heard.ts) or a new line about the day brings their "…" back.
 * Just after a first meeting the stage's own lines wait quietly for the
 * next talk (no "…" straight away).
 */
function residentHasNews(session: Session, id: string): boolean {
  const talk = residentTalk(id, residentContext(session))
  const flags = session.state.flags
  if (talk.first) return true
  const story = !heardStory(flags, id, talk.story.key) && metAt(flags, id as ResidentId) !== talk.story.key
  return story || (!!talk.day && !heardDay(id, talk.day.topic))
}


export class Interactables {
  readonly list: Interactable[] = []
  currentTarget: Interactable | null = null
  /** undefined until the first frame, so a new area always clears a stale prompt. */
  private lastPrompt: string | null | undefined = undefined
  /** Floating "!" / "…" markers keyed by interactable id. */
  private markers = new Map<string, Phaser.GameObjects.Image>()
  /** Keycap hint floating above the current interaction target. */
  private keyHint: Phaser.GameObjects.Image | null = null
  private readonly village: Village

  constructor(private scene: Phaser.Scene, private deps: InteractableDeps) {
    this.village = deps.village ?? villageFor(deps.session)
    const { world } = deps
    for (const n of world.npcs) {
      this.list.push({
        id: n.id,
        x: n.tx * TILE + 8,
        y: n.ty * TILE + TILE - 4,
        label: `Talk to ${NPC_NAMES[n.id]}`
      })
    }
    if (world.mural) {
      this.list.push({ id: 'clue', x: world.mural.tx * TILE + 8, y: world.mural.ty * TILE + TILE, label: 'Study the route marker' })
    }
    if (world.shrine) {
      this.list.push({ id: 'lantern', x: world.shrine.tx * TILE + 8, y: world.shrine.ty * TILE + TILE, label: 'Look at the lantern' })
    }
    for (const spot of world.emberSpots) {
      this.list.push({
        id: spot.id,
        x: spot.tx * TILE + 8,
        y: spot.ty * TILE + TILE,
        label: spot.id === 'hearth' ? 'Sit by the lantern' : spot.id === 'chest' ? 'Look at the chest' : 'Look at the lantern'
      })
    }
    if (deps.papers) this.list.push(...deps.papers.interactions())
  }

  /** Attach the runtime provider (it is built after this, since it pushes points here). */
  setExtra(extra: InteractionProvider): void {
    this.deps.extras = [...(this.deps.extras ?? []), extra]
  }

  /** The runtime provider that answers for this id, if any. */
  private extra(id: InteractId): InteractionProvider | undefined {
    return this.deps.extras?.find((p) => p.owns(id))
  }

  /** Interaction points each provider pushes; each provider's set is replaced wholesale. */
  private dynamicBy = new Map<InteractionProvider | undefined, Interactable[]>()
  private markersBuilt = false
  /** Residents away from their spot (their markers wait there, hidden: ./npcs.ts `away`). */
  private awayCheck: ((id: string) => boolean) | null = null
  private awayNow = ''

  /** Say who is away from their spot right now (checked every frame). */
  setAway(check: (id: string) => boolean): void {
    this.awayCheck = check
  }

  /** Replace a provider's interaction points (and their markers). */
  setDynamic(list: Interactable[], owner?: InteractionProvider): void {
    for (const it of this.dynamicBy.get(owner) ?? []) {
      const i = this.list.indexOf(it)
      if (i >= 0) this.list.splice(i, 1)
      const marker = this.markers.get(it.id)
      if (marker) this.scene.tweens.killTweensOf(marker)
      marker?.destroy()
      this.markers.delete(it.id)
      if (this.currentTarget === it) this.currentTarget = null
    }
    this.dynamicBy.set(owner, list)
    this.list.push(...list)
    if (this.markersBuilt) {
      for (const it of list) this.addMarker(it)
      this.refreshMarkers()
    }
    this.lastPrompt = undefined
  }

  private addMarker(it: Interactable): void {
    const img = this.scene.add.image(it.x, it.y - this.markerOffset(it.id), 'mark-quest')
      .setOrigin(0.5, 1)
      .setDepth(6000)
      .setVisible(false)
    if (!this.deps.reducedMotion) {
      this.scene.tweens.add({ targets: img, y: img.y - 2, duration: 650, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }
    this.markers.set(it.id, img)
  }

  /** "!" over whoever moves the story on, "…" over anyone with news. */
  buildMarkers(): void {
    this.markersBuilt = true
    for (const it of this.list) {
      const img = this.scene.add.image(it.x, it.y - this.markerOffset(it.id), 'mark-quest')
        .setOrigin(0.5, 1)
        .setDepth(6000)
        .setVisible(false)
      if (!this.deps.reducedMotion) {
        this.scene.tweens.add({ targets: img, y: img.y - 2, duration: 650, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
      }
      this.markers.set(it.id, img)
    }
    this.keyHint = this.scene.add.image(0, 0, isTouchFirst() ? 'key-tap' : 'key-e')
      .setOrigin(0.5, 1)
      .setDepth(6001)
      .setVisible(false)
    this.refreshMarkers()
    // A new day, project or plot can give a resident something new to say.
    const refresh = () => {
      if (this.scene.sys?.isActive()) this.refreshMarkers()
    }
    bus.on(VILLAGE_EV.changed, refresh)
    bus.on(HOME_EV.changed, refresh)
    const off = () => {
      bus.off(VILLAGE_EV.changed, refresh)
      bus.off(HOME_EV.changed, refresh)
    }
    this.scene.events.once('shutdown', off)
    this.scene.events.once('destroy', off)
  }

  refreshMarkers(): void {
    const stage = this.deps.session.questStage
    for (const it of this.list) {
      const img = this.markers.get(it.id)
      if (!img || !img.active) continue
      let kind: 'quest' | 'talk' | null = null
      if (this.deps.papers?.owns(it.id)) {
        kind = null // pickups sparkle instead; the library is a building
      } else if (this.extra(it.id)) {
        kind = this.extra(it.id)!.marker?.(it.id) ?? null
      } else if (this.isEmberSpot(it.id)) {
        kind = this.emberSpotReady(it.id) ? 'talk' : null
      } else if (isResident(it.id)) {
        const flags = this.deps.session.state.flags
        const adaSpade = it.id === 'ada' && Boolean(this.deps.session.link) && countAdaOilGifts(flags) >= 3 && !flags.includes('heirloom:ada-garden-spade') && !itemsFor(this.deps.session).isGrantInFlight('ada-garden-spade')
        if (residentHasNews(this.deps.session, it.id) || handoverFor(it.id, stage, flags) || adaSpade) kind = 'talk'
      } else {
        const flags = this.deps.session.state.flags
        const orrinPick = it.id === 'orrin' && Boolean(this.deps.session.link) && this.village.hasWorldFlag('project:north-bridge:complete') && !flags.includes('heirloom:orrins-mason-pick') && !itemsFor(this.deps.session).isGrantInFlight('orrins-mason-pick')
        try {
          const d = dialogueFor(it.id, stage)
          if (d.event) kind = 'quest'
          else if (orrinPick) kind = 'talk'
          else if (it.id in NPC_NAMES && !heardStory(flags, it.id, stage)) kind = 'talk'
          else if (it.id in NPC_NAMES && handoverFor(it.id, stage, flags)) kind = 'talk'
        } catch {
          kind = null
        }
      }
      if (kind) img.setTexture(kind === 'quest' ? 'mark-quest' : 'mark-talk')
      img.setVisible(kind !== null && this.currentTarget?.id !== it.id && !this.awayCheck?.(it.id))
    }
  }

  /**
   * Nearest interactable within reach drives the prompt, markers and key hint.
   * An `action` (the warden standing open to the naming) outranks them all.
   */
  updatePrompt(player: { x: number; y: number }, now: number, action: PromptAction | null = null): void {
    // Nearest interactable within reach
    let best: Interactable | null = null
    let bestDist = action ? -1 : 34
    for (const it of this.list) {
      const d = Math.hypot(player.x - it.x, player.y - 8 - (it.y - 8))
      if (d < bestDist) {
        bestDist = d
        best = it
      }
    }
    const away = this.awayCheck ? this.list.filter((it) => this.awayCheck!(it.id)).map((it) => it.id).join(',') : ''
    if (best !== this.currentTarget || away !== this.awayNow) {
      this.currentTarget = best
      this.awayNow = away
      this.refreshMarkers()
    }
    // Recomputed every frame: the wording follows quest progress even while
    // the hero stands still next to the target.
    const label = action ? action.label : best ? this.promptLabel(best) : null
    if (label !== this.lastPrompt) {
      this.lastPrompt = label
      const verb = !action && best && this.extra(best.id) ? this.extra(best.id)!.verb?.(best.id) : null
      const payload: PromptPayload = action && label ? { label, verb: action.verb } : verb && label ? { label, verb } : { label }
      bus.emit(EV.prompt, payload)
    }
    if (this.keyHint) {
      if (action) {
        this.keyHint.setPosition(action.x, action.y).setVisible(true)
      } else if (best) {
        const bob = this.deps.reducedMotion ? 0 : Math.round(Math.sin(now * 0.008) * 1)
        this.keyHint.setPosition(best.x, best.y - this.markerOffset(best.id) + bob).setVisible(true)
      } else {
        this.keyHint.setVisible(false)
      }
    }
  }

  /** Open the conversation at an interactable (dialogue panel owns the screen). */
  open(target: Interactable): void {
    const { session, papers } = this.deps
    if (papers?.owns(target.id)) {
      if (papers.activate(target.id)) this.remove(target)
      return
    }
    if (this.extra(target.id)) {
      this.extra(target.id)!.activate(target.id)
      return
    }
    let payload: Dialogue
    try {
      if (isResident(target.id)) {
        // Residents talk around the quest: their words come from the save,
        // the calendar, the world's projects and your plot. Heard before:
        // a greeting, anything new about the day, and "Hear it again".
        const talk = residentTalk(target.id, residentContext(session))
        payload = talk.dialogue
        const flags = session.state.flags
        if (!talk.first && heardStory(flags, target.id, talk.story.key)) {
          const fresh = talk.day && !heardDay(target.id, talk.day.topic) ? [talk.day.line] : []
          payload = { ...payload, ...shortTalk({ greeting: greetingFor(target.id), fresh, full: talk.dialogue.lines, choices: payload.choices }) }
        }
        markStory(session, target.id, talk.story.key)
        if (talk.day) markDay(target.id, talk.day.topic)
        if (talk.first) {
          meetResident(session, target.id)
          bus.emit(EV.toast, { text: `${residentFullName(target.id)}: noted in your journal.`, icon: 'book', kind: 'gain', gain: { to: 'journal', label: residentFullName(target.id) } })
        }
      } else payload = this.isEmberSpot(target.id)
        ? emberDialogue(target.id, session.state, {
          connected: session.vitalsSource === 'imported',
          remote: session.link ? (session.link.online ? 'online' : 'offline') : null
        })
        : this.storyTalk(target.id, dialogueFor(target.id, session.questStage))
    } catch (err) {
      console.warn('[fingersnap] no dialogue available for', target.id, err)
      return
    }
    // A paper to hand over rides at the end of the NPC's usual lines.
    const handover = !this.isEmberSpot(target.id) && target.id in NPC_NAMES ? papers?.handover(target.id) : null
    if (handover) payload = { ...payload, lines: [...payload.lines, ...handover] }
    // Carrying a resident's keepsake adds the quiet line (give it back / not yet).
    const ask = isResident(target.id)
      ? keepsakeAsk(target.id, session.state.flags, itemsFor(session).view?.stacks.map((s) => s.itemDef) ?? [])
      : null
    if (ask) payload = { ...payload, lines: [...payload.lines, ask.line], choices: ask.choices }
    // One more choice, and a single "Not yet" at the end (an earlier one,
    // e.g. a keepsake's with its own reply, is kept in its place).
    const withChoiceAndNotYet = (existing: DialogueChoice[] | undefined, newChoice: DialogueChoice): DialogueChoice[] => {
      // A short talk's plain goodbye becomes "Not yet" once there's something on offer.
      const found = (existing ?? []).find((c) => c.text === 'Not yet' || c.dismiss)
      const notYet = found && found.text !== 'Not yet' ? { text: 'Not yet', dismiss: true } : (found ?? { text: 'Not yet' })
      const nonNotYet = (existing ?? []).filter((c) => c !== found)
      return [...nonNotYet, newChoice, notYet]
    }
    // What a resident sells at their own door (Hazel's kitchen, Finn's
    // mill door): a choice at the end of the talk, when there's a world to
    // keep the books. Their words for it are the reply.
    const seller = (ITEMS.sellers ?? []).find((sl) => sl.npc.toLowerCase() === target.id && !sl.festival)
    if (seller && session.link) {
      for (const g of seller.goods) {
        payload = { ...payload, choices: withChoiceAndNotYet(payload.choices, { text: g.label, reply: [g.line], action: `buy:${seller.id}:${g.item}` }) }
      }
    }

    // Heirloom beats: Orrin's mason pick and Ada's garden spade
    if (target.id === 'orrin' && this.village.hasWorldFlag(NORTH_BRIDGE_DONE) && !session.state.flags.includes('heirloom:orrins-mason-pick')) {
      if (!session.link) {
        payload = {
          ...payload,
          lines: [...payload.lines, HEIRLOOM_GUEST_LINES.orrin]
        }
      } else {
        // Offered only when Orrin can hand it over now; otherwise he says why.
        const beat = heirloomBeat(session, 'orrins-mason-pick', 'Take Orrin’s mason pick', [NORTH_BRIDGE_DONE])
        if (beat) {
          payload = {
            ...payload,
            lines: [...payload.lines, ...beat.lines],
            choices: beat.choices.length ? withChoiceAndNotYet(payload.choices, beat.choices[0]) : payload.choices
          }
        }
      }
    } else if (target.id === 'ada') {
      const gifts = countAdaOilGifts(session.state.flags)
      if (gifts >= 3 && !session.state.flags.includes('heirloom:ada-garden-spade')) {
        if (!session.link) {
          payload = {
            ...payload,
            lines: [...payload.lines, HEIRLOOM_GUEST_LINES.adaSpade]
          }
        } else {
          const beat = heirloomBeat(session, 'ada-garden-spade', 'Take Ada’s garden spade')
          if (beat) {
            payload = {
              ...payload,
              lines: [...payload.lines, ...beat.lines],
              choices: beat.choices.length ? withChoiceAndNotYet(payload.choices, beat.choices[0]) : payload.choices
            }
          }
        }
      } else if (gifts < 3) {
        const carriesOil = session.state.inventory.some((i) => i === 'hearth-oil') ||
          (itemsFor(session).view?.stacks.some((s) => s.itemDef === 'hearth-oil' && s.qty > 0) ?? false)
        if (carriesOil) {
          if (!session.link) {
            payload = {
              ...payload,
              lines: [...payload.lines, HEIRLOOM_GUEST_LINES.adaOil]
            }
          } else if (!itemsFor(session).isAdaOilInFlight()) {
            payload = {
              ...payload,
              choices: withChoiceAndNotYet(payload.choices, { text: 'Give hearth oil for the window', action: 'ada:oil' })
            }
          }
        }
      }
    }
    uiState.dialogueOpen = true
    this.refreshMarkers()
    sfx('open')
    bus.emit(EV.dialogue, {
      id: target.id,
      speaker: payload.speaker,
      lines: payload.lines,
      event: payload.event,
      choices: payload.choices
    })
  }

  /**
   * Mara, Pip, Orrin (and the stone and the lantern, which don't greet): a
   * stage's lines play in full once; a quest step (an event) always plays
   * in full. After that, a greeting and "Hear it again".
   */
  private storyTalk(id: string, d: Dialogue): Dialogue {
    if (!(id in NPC_NAMES) || d.event) return d
    const { session } = this.deps
    const stage = session.questStage
    const heard = heardStory(session.state.flags, id, stage)
    markStory(session, id, stage)
    if (!heard) return d
    return { ...d, ...shortTalk({ greeting: greetingFor(id), fresh: [], full: d.lines, choices: d.choices }) }
  }

  /** Drop a used-up interaction point (a picked-up paper) and its marker. */
  private remove(target: Interactable): void {
    const i = this.list.indexOf(target)
    if (i >= 0) this.list.splice(i, 1)
    this.markers.get(target.id)?.destroy()
    this.markers.delete(target.id)
    if (this.currentTarget === target) this.currentTarget = null
    this.keyHint?.setVisible(false)
    this.lastPrompt = null
    const payload: PromptPayload = { label: null }
    bus.emit(EV.prompt, payload)
  }

  /** Hide the keycap hint while the world is frozen (a panel owns input). */
  hideKeyHint(): void {
    this.keyHint?.setVisible(false)
  }

  /**
   * How far away the nearest thing you could press E at is (as of the last
   * prompt update — one frame old at most). A working spot proposes its
   * prompt only when it is nearer than this (a fallen bucket right there
   * outranks the woods behind it).
   */
  nearest(player: { x: number; y: number }): number {
    let best = Infinity
    for (const it of this.list) {
      const d = Math.hypot(player.x - it.x, player.y - 8 - (it.y - 8))
      if (d < best) best = d
    }
    return best
  }

  /** Force the next updatePrompt to re-emit (an ember spend changed the wording). */
  invalidatePrompt(): void {
    this.lastPrompt = undefined
  }

  private isEmberSpot(id: InteractId): id is EmberSpotId {
    return id === 'hearth' || id === 'chest' || (ROAD_LANTERNS as readonly string[]).includes(id)
  }

  /** Whether an ember spot has something to buy right now (drives its marker). */
  private emberSpotReady(id: EmberSpotId): boolean {
    const spend: EmberSpend = id === 'hearth' ? { kind: 'rest' } : id === 'chest' ? { kind: 'chest' } : { kind: 'road-lantern', id }
    return this.deps.session.checkSpend(spend).ok
  }

  /** Prompt wording that says what pressing the button will actually do. */
  private promptLabel(it: Interactable): string {
    const { session } = this.deps
    const stage = session.questStage
    if (this.extra(it.id)) return this.extra(it.id)!.label?.(it.id) ?? it.label
    if (it.id === 'clue') return stage === 'accepted' ? 'Copy the naming from the stone' : it.label
    if (it.id === 'lantern') return stage === 'guardian-defeated' ? 'Light the lantern' : it.label
    if (it.id === 'chest') return session.state.flags.includes('opened:ashwatch-chest') ? it.label : `Open the chest · ${EMBER_COSTS.chest} embers`
    if (it.id === 'hearth') return `Rest by the lantern · ${EMBER_COSTS.rest} embers`
    if (this.isEmberSpot(it.id)) {
      return isLit(session.state, it.id as RoadLanternId) ? it.label : `Light the lantern · ${EMBER_COSTS.roadLantern} embers`
    }
    return it.label
  }

  /** Height above an interactable's base where its marker floats. */
  private markerOffset(id: InteractId): number {
    const extra = this.extra(id)?.markerOffset?.(id) ?? null
    if (typeof extra === 'number') return extra
    if (id === 'lantern') return 44
    if (id === 'hearth') return 36
    if (id === 'road-1' || id === 'road-2' || id === 'road-3') return 32
    if (id === 'clue' || id === 'chest') return 22
    if (id === 'library') return 44
    if (id.startsWith('paper:')) return 12
    return 25
  }
}
