/**
 * The people and places an area is built with, as interaction points: the
 * quest NPCs and residents, the route marker, the shrine lantern and the
 * ember spots. Each point carries its prompt wording (it follows the story),
 * its marker ("!" moves the story on, "…" someone has news) and the
 * conversation it opens.
 */
import { dialogueFor, emberDialogue, type Dialogue, type DialogueChoice } from '../../content/world'
import { EMBER_COSTS, isLit, ROAD_LANTERNS, type EmberSpend, type RoadLanternId } from '../../lib/embers'
import { ITEMS } from '../../lib/items'
import { sellerChoices } from '../../lib/purse'
import { bus, EV } from '../events'
import type { Session } from '../session'
import { tileBottom, tileMid } from '../../lib/tile'
import type { EmberSpotId, WorldData } from '../worlds'
import { NPC_NAMES } from './npcs'
import { handoverFor } from '../../content/papers'
import { isResident, keeperTalk, metAt, residentFullName, residentTalk, type ResidentId } from '../../content/residents'
import { shortTalk } from '../../content/talk'
import { greetingFor, heardDay, heardStory, markDay, markStory } from '../heard'
import { meetResident, residentContext } from '../residents'
import { itemsFor } from '../items'
import { keepsakeAsk } from '../keepsakes'
import type { Village } from '../village'
import { HEIRLOOM_GUEST_LINES, NORTH_BRIDGE_DONE, countAdaOilGifts } from '../../content/heirlooms'
import { heirloomBeat } from '../heirloom-beats'
import { openDialogue } from '../dialogue'
import { afterTheirTalk, questMarker, questTalk, rumourChoice, takesTheTalk } from '../../content/quests/index.ts'
import { questContext } from '../guide-pin'
import { placeArea } from '../../lib/api/predict'
import { LIBRARY } from '../room-spots'
import type { Interactable, Interactables, MarkerKind } from './interactables'
import type { PaperPickups } from './papers'

export interface WorldTalkDeps {
  world: WorldData
  session: Session
  village: Village
  interactables: Interactables
  /** NPCs hand over papers at the end of their lines. */
  papers?: PaperPickups
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

const isEmberSpot = (id: string): id is EmberSpotId => id === 'hearth' || id === 'chest' || (ROAD_LANTERNS as readonly string[]).includes(id)

export class WorldTalk {
  constructor(private deps: WorldTalkDeps) {
    const { world } = deps
    const points: Interactable[] = []
    for (const n of world.npcs) {
      const id = n.id
      points.push({
        id,
        x: tileMid(n.tx),
        y: tileBottom(n.ty) - 4,
        label: `Talk to ${NPC_NAMES[id]}`,
        marker: () => (isResident(id) ? this.residentMarker(id) : this.storyMarker(id)),
        activate: () => this.talk(id)
      })
    }
    if (world.mural) {
      points.push({
        id: 'clue',
        x: tileMid(world.mural.tx),
        y: tileBottom(world.mural.ty),
        label: () => (deps.session.questStage === 'accepted' ? 'Copy the naming from the stone' : 'Study the route marker'),
        marker: () => this.storyMarker('clue'),
        markerOffset: 22,
        activate: () => this.talk('clue')
      })
    }
    if (world.shrine) {
      points.push({
        id: 'lantern',
        x: tileMid(world.shrine.tx),
        y: tileBottom(world.shrine.ty),
        label: () => (deps.session.questStage === 'guardian-defeated' ? 'Light the lantern' : 'Look at the lantern'),
        marker: () => this.storyMarker('lantern'),
        markerOffset: 44,
        activate: () => this.talk('lantern')
      })
    }
    for (const spot of world.emberSpots) {
      const id = spot.id
      points.push({
        id,
        x: tileMid(spot.tx),
        y: tileBottom(spot.ty),
        label: () => this.emberLabel(id),
        marker: () => (this.emberSpotReady(id) ? 'talk' : null),
        markerOffset: id === 'hearth' ? 36 : id === 'chest' ? 22 : 32,
        activate: () => this.talk(id)
      })
    }
    deps.interactables.register(this, points)
  }

  /** "…" over a resident with news, a paper to hand over, or Ada's spade waiting. */
  private residentMarker(id: string): MarkerKind {
    const { session } = this.deps
    const flags = session.state.flags
    const adaSpade = id === 'ada' && Boolean(session.link) && countAdaOilGifts(flags) >= 3 && !flags.includes('heirloom:ada-garden-spade') && !itemsFor(session).isGrantInFlight('ada-garden-spade')
    // A quest step that talking takes (once you've been introduced).
    if (!residentTalk(id, residentContext(session)).first && questMarker(id, questContext(session))) return 'quest'
    return residentHasNews(session, id) || handoverFor(id, session.questStage, flags) || adaSpade ? 'talk' : null
  }

  /** "!" when talking moves the story on; "…" for an unheard stage, a paper, or Orrin's pick. */
  private storyMarker(id: string): MarkerKind {
    const { session } = this.deps
    const stage = session.questStage
    const flags = session.state.flags
    const orrinPick = id === 'orrin' && Boolean(session.link) && this.deps.village.hasWorldFlag('project:north-bridge:complete') && !flags.includes('heirloom:orrins-mason-pick') && !itemsFor(session).isGrantInFlight('orrins-mason-pick')
    try {
      const d = dialogueFor(id, session.quests)
      if (d.event || questMarker(id, questContext(session))) return 'quest'
      if (orrinPick) return 'talk'
      if (id in NPC_NAMES && !heardStory(flags, id, d.key ?? stage)) return 'talk'
      if (id in NPC_NAMES && handoverFor(id, stage, flags)) return 'talk'
    } catch {
      return null
    }
    return null
  }

  /** What pressing at an ember spot buys, with its price. */
  private emberLabel(id: EmberSpotId): string {
    const { session } = this.deps
    if (id === 'chest') return session.state.flags.includes('opened:ashwatch-chest') ? 'Look at the chest' : `Open the chest · ${EMBER_COSTS.chest} embers`
    if (id === 'hearth') return `Rest by the lantern · ${EMBER_COSTS.rest} embers`
    return isLit(session.state, id as RoadLanternId) ? 'Look at the lantern' : `Light the lantern · ${EMBER_COSTS.roadLantern} embers`
  }

  /** Whether an ember spot has something to buy right now (drives its marker). */
  private emberSpotReady(id: EmberSpotId): boolean {
    const spend: EmberSpend = id === 'hearth' ? { kind: 'rest' } : id === 'chest' ? { kind: 'chest' } : { kind: 'road-lantern', id }
    return this.deps.session.checkSpend(spend).ok
  }

  /** Open the conversation at a person or spot (the dialogue panel owns the screen). */
  private talk(id: string): void {
    const { session, papers } = this.deps
    let payload: Dialogue
    try {
      const quest = questContext(session)
      const talk = isResident(id) ? residentTalk(id, residentContext(session)) : null
      // A quest step that talking to them takes (a resident once you've been introduced):
      // the whole talk only when it takes it (indoors.md 5.9), else after their own lines.
      const step = talk?.first ? null : questTalk(id, quest)
      const takes = !!step && takesTheTalk(step, quest)
      if (talk && step && takes) payload = step
      else if (talk && isResident(id)) {
        // Residents talk around the quest: their words come from the save,
        // the calendar, the world's projects and your plot. Heard before:
        // a greeting, anything new about the day, and "Hear it again".
        payload = talk.dialogue
        const flags = session.state.flags
        if (!talk.first && heardStory(flags, id, talk.story.key)) {
          const fresh = talk.day && !heardDay(id, talk.day.topic) ? [talk.day.line] : []
          payload = { ...payload, ...shortTalk({ greeting: greetingFor(id), fresh, full: talk.dialogue.lines, choices: payload.choices }) }
        }
        markStory(session, id, talk.story.key)
        if (talk.day) markDay(id, talk.day.topic)
        if (talk.first) {
          meetResident(session, id)
          bus.emit(EV.toast, { text: `${residentFullName(id)}: noted in your journal.`, icon: 'book', kind: 'gain', gain: { to: 'journal', label: residentFullName(id) } })
        }
        // "Heard anything?": an open quest you haven't pinned, in their voice.
        const rumour = talk.first ? null : rumourChoice(id, quest)
        if (rumour) payload = { ...payload, choices: [rumour, ...(payload.choices ?? [])] }
        // Elara keeping the library: the shelves, and donating through her (indoors.md 3.3).
        if (id === 'elara' && placeArea(session.state) === LIBRARY) payload = keeperTalk(payload, talk.first)
        // Another quest's start or reminder: after they've said their piece.
        if (step && !takes) payload = afterTheirTalk(payload, step)
      } else payload = isEmberSpot(id)
        ? emberDialogue(id, session.state, {
          connected: session.vitalsSource === 'imported',
          remote: session.link ? (session.link.online ? 'online' : 'offline') : null
        })
        : this.storyOrQuestTalk(id)
    } catch (err) {
      console.warn('[glimway] no dialogue available for', id, err)
      return
    }
    // A paper to hand over rides at the end of the NPC's usual lines.
    const handover = !isEmberSpot(id) && id in NPC_NAMES ? papers?.handover(id) : null
    if (handover) payload = { ...payload, lines: [...payload.lines, ...handover] }
    // Carrying a resident's keepsake adds the quiet line (give it back / not yet).
    const ask = isResident(id)
      ? keepsakeAsk(id, session.state.flags, itemsFor(session).view?.stacks.map((s) => s.itemDef) ?? [])
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
    // keep the books. Their words for it are the reply. A good priced in
    // embers and in gold is two choices (purse-and-wardrobe.md 3.1).
    const seller = (ITEMS.sellers ?? []).find((sl) => sl.npc.toLowerCase() === id && !sl.festival)
    if (seller && session.link) {
      for (const c of sellerChoices(seller, { reply: true })) {
        payload = { ...payload, choices: withChoiceAndNotYet(payload.choices, c) }
      }
    }

    // Heirloom beats: Orrin's mason pick and Ada's garden spade
    if (id === 'orrin' && this.deps.village.hasWorldFlag(NORTH_BRIDGE_DONE) && !session.state.flags.includes('heirloom:orrins-mason-pick')) {
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
    } else if (id === 'ada') {
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
    this.deps.interactables.refreshMarkers()
    openDialogue({
      id: id,
      speaker: payload.speaker,
      lines: payload.lines,
      event: payload.event,
      choices: payload.choices
    })
  }

  /**
   * Mara, Pip, Orrin: the story's rule, with a quest's talk by the rule of
   * who speaks first (indoors.md 5.9). A step that takes the talk (the
   * opening's, or one you're mid-way through here) is the talk; any other
   * follows their lines. A story line that moves the road on goes alone:
   * the other quest waits for the next talk.
   */
  private storyOrQuestTalk(id: string): Dialogue {
    const { session } = this.deps
    const ctx = questContext(session)
    const d = dialogueFor(id, session.quests)
    const step = questTalk(id, ctx)
    if (!step || d.event) return this.storyTalk(id, d)
    return takesTheTalk(step, ctx) ? step : afterTheirTalk(this.storyTalk(id, d), step)
  }

  /**
   * Mara, Pip, Orrin (and the stone and the lantern, which don't greet): a
   * stage's lines play in full once; a quest step (an event) always plays
   * in full. After that, a greeting and "Hear it again".
   */
  private storyTalk(id: string, d: Dialogue): Dialogue {
    if (!(id in NPC_NAMES) || d.event) return d
    const { session } = this.deps
    const key = d.key ?? session.questStage
    const heard = heardStory(session.state.flags, id, key)
    markStory(session, id, key)
    if (!heard) return d
    return { ...d, ...shortTalk({ greeting: greetingFor(id), fresh: [], full: d.lines, choices: d.choices }) }
  }
}
