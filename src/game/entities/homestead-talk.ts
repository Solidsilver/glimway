import { lotAtPixel } from '../../lib/lots'
/**
 * Homesteads, talked to: everything you can use on the Commons, at Silas's
 * Yard, on a homestead's land and in a cottage (each point with its own
 * prompt and action): Silas's short talk and Pell's deeds (../yard-talk.ts),
 * resting at home, and the placed seats. The Yard panel sells and builds;
 * the Manage your deed panel shares and gives up (../yard-open.ts).
 */
import Phaser from 'phaser'
import { HOMESTEAD_DATA, type HomeScene } from '../../lib/homestead'
import { checkSpend } from '../../lib/glims'
import { glimsCount } from '../../content/purse'
import type { HomeView } from '../../lib/api/types'
import { CARTING_DAY_NOTICE } from '../../content/expansion-writing'
import type { Dialogue, DialogueChoice } from '../../content/world'
import { heardStory, markStory } from '../heard'
import { paperFlag } from '../../content/papers'
import { knowsHollisName } from '../../content/heirlooms'
import { heirloomBeat } from '../heirloom-beats'
import { EMPTY_CHAIR_LINE, SEAT_LINES } from '../../content/touches'
import { KEPT_EMPTY, isSeatItem } from '../seats'
import { bus, EV } from '../events'
import { uiState } from '../input'
import { sfx } from '../sfx'
import { TILE, tileBottom, tileMid } from '../../lib/tile'
import { ROOM_BENCH, ROOM_CHEST, ROOM_HEARTH } from '../cottage'
import { grantPaper } from '../papers'
import { itemsFor } from '../items'
import { keepsakeAsk } from '../keepsakes'
import type { VillagePanel } from '../village'
import { HOME_FLAGS, PAPERS, SILAS, lotName } from '../homestead'
import type { Interactable, MarkerKind } from './interactables'
import { DialogueHold } from '../dialogue-hold'
import { stablePoints } from './homestead-stable'
import { openDialogue } from '../dialogue'
import type { HomesteadDeps, HomesteadLayer } from './homesteads'
import { POST, short } from './homestead-art'
import { openDeedPanel, openYard } from '../yard-open'
import { PELL, PELL_DEED } from '../../content/pell'
import { MANAGE_DEED, SEE_THE_YARD, isYardRoom, pellTalk, silasTalk } from '../yard-talk'
import { standsAtTable } from '../deed-table'
import { pinned, setPinned } from '../guide-pin'

/** Story marks (src/game/heard.ts): you've met Pell, and heard Pell's pitch for a first deed. */
const PELL_MET = 'met'
const PELL_PITCH = 'pitch'
/** Silas pointed you at Pell and pinned the claim guide (once). */
const SILAS_PINNED_PELL = 'pinned-pell'

export class HomesteadTalk {
  private readonly scene: Phaser.Scene
  private readonly deps: HomesteadDeps

  private idleLine = Math.floor(Math.random() * SILAS.dialogue.idleLines.length)
  private pellLine = Math.floor(Math.random() * PELL.idleLines.length)
  /** The next sit line for a placed seat (cycling). */
  private seatLine = 0
  /** The world held still while Silas or Pell reads the plot book. */
  readonly silasHold = new DialogueHold(uiState)

  constructor(private readonly home: HomesteadLayer) {
    this.scene = home.scene
    this.deps = home.deps
  }

  /**
   * Placed seats (stools, chairs) anyone here can sit on, like the village
   * benches; the Empty Chair is only looked at.
   */
  private seatPoints(home: HomeView, scene: HomeScene): Interactable[] {
    const out: Interactable[] = []
    for (const it of home.items) {
      if (it.scene !== scene || it.x === null || it.y === null) continue
      const seated = () => this.deps.sitter().isSeated
      const seat = (label: string, verb: string): Interactable => ({
        id: `home:seat:${it.id}`,
        ...this.home.art.decoSpot(it, scene),
        label: () => (seated() ? 'Stand up' : label),
        verb: () => (seated() ? 'Stand' : verb),
        markerOffset: 16,
        activate: () => this.useSeat(it.id)
      })
      if (it.itemDef === KEPT_EMPTY) out.push(seat('Look at the Empty Chair', 'Look'))
      else if (isSeatItem(it.itemDef)) out.push(seat(`Sit ${it.itemDef === 'wooden-stool' ? 'on the stool' : 'in the reading chair'}`, 'Sit'))
    }
    return out
  }

  /** Sit on a placed seat, or stand back up from it. */
  private useSeat(itemId: string): void {
    const sitter = this.deps.sitter()
    if (sitter.isSeated) return sitter.standUp()
    const it = this.home.here()?.items.find((i) => i.id === itemId)
    if (!it || it.scene === null) return
    if (it.itemDef === KEPT_EMPTY) return this.say({ speaker: 'The Empty Chair', lines: [EMPTY_CHAIR_LINE] })
    const pose = this.home.art.seatPose(it)
    if (!pose) return
    sitter.sit(pose)
    sfx('settle')
    const lines = SEAT_LINES[it.itemDef] ?? []
    const n = this.seatLine++
    if (lines.length) bus.emit(EV.toast, { text: lines[n % lines.length], icon: 'sparkle', kind: 'thought' })
  }

  /**
   * Everything you can use here: indoors the hearth, desk, seats, chest and
   * bench; on the land the mailbox, door or bedroll, lamps and woodpiles;
   * on the lane Silas, the gate's furniture and every lot's sign and shelf.
   * Each point carries its own prompt, button word, marker and action.
   */
  interactionList(): Interactable[] {
    const out: Interactable[] = []
    const say = (speaker: string, lines: string[]) => () => this.say({ speaker, lines })
    const panel = (which: VillagePanel, gate?: number) => () => {
      bus.emit(EV.villageOpen, gate === undefined ? { panel: which } : { panel: which, gate })
    }
    const restCost = () => checkSpend(this.deps.session.state, { kind: 'home-rest' }).cost
    const placeName = () => this.home.placeName(this.home.here(), this.home.gate ?? 0)
    if (this.deps.room) {
      out.push({
        id: 'home:hearth',
        x: ROOM_HEARTH.x + 8,
        y: ROOM_HEARTH.y + 10,
        label: () => (this.ownRoom() ? `Rest by your hearth · ${glimsCount(restCost())}` : 'Sit by the hearth'),
        verb: 'Rest',
        markerOffset: 16,
        activate: () =>
          this.ownRoom()
            ? this.offerRest('Your hearth')
            : say(placeName(), ['Quarried stone, never drift-stone. It is warm, and it isn’t yours to sit by. Leave one for Ada, and let yourself out.'])()
      })
      const home = this.home.here()
      // Cooking at the hearth (your own place, connected): the hearth recipes.
      if (home?.member && this.home.homes.connected) {
        out.push({ id: 'home:cook', x: ROOM_HEARTH.x - 14, y: ROOM_HEARTH.y + 14, label: 'Cook at the hearth', verb: 'Cook', markerOffset: 16, activate: panel('hearth') })
      }
      if (home) {
        for (const it of home.items) {
          if (!home.member || !this.home.homes.connected) break
          if (it.itemDef !== 'writing-desk' || it.scene !== 'indoor' || it.x === null || it.y === null) continue
          out.push({
            id: `home:desk:${it.id}`,
            ...this.home.art.decoSpot(it, 'indoor'),
            label: 'Sit at the desk',
            verb: 'Sit',
            markerOffset: 16,
            activate: () =>
              !this.ownRoom() || !this.home.homes.connected
                ? say('A writing desk', ['A slant-top desk, a jar of quills, rag paper. Its owner copies out pages here.'])()
                : panel('desk')()
          })
        }
        out.push(...this.seatPoints(home, 'indoor'))
      }
      if (home && home.tier >= 2) {
        out.push({
          id: 'home:chest',
          x: ROOM_CHEST.x,
          y: 60,
          label: home.member ? 'Open the chests' : 'Look at the chest',
          verb: 'Look',
          markerOffset: 16,
          activate: () => (this.ownRoom() ? panel('chest')() : say('The chest', [`Oak and iron, waxed against the damp. It belongs to ${placeName()}, and it’s shut.`])())
        })
        out.push({
          id: 'home:bench',
          x: ROOM_BENCH.x,
          y: 60,
          label: home.member ? 'Work at the bench' : 'Look at the bench',
          verb: 'Look',
          markerOffset: 16,
          activate: () => (this.ownRoom() ? panel('bench')() : say('The bench', [`A heavy bench, clean tools racked over it. Someone at ${placeName()} keeps it tidy.`])())
        })
      }
      return out
    }
    if (this.home.land) {
      const L = this.home.land
      const home = this.home.here()
      if (!home) {
        out.push({
          id: 'home:stake',
          x: (L.gridOrigin?.x ?? 0) + (L.site.x + L.site.w / 2) * TILE,
          y: (L.gridOrigin?.y ?? 0) + (L.site.y + L.site.h - 1) * TILE + 2,
          label: 'Read the sign',
          verb: 'Read',
          markerOffset: 16,
          activate: () => this.readStake()
        })
        return out
      }
      const box = this.home.art.mailboxSpot()
      const first = home.members.find((m) => m.id !== this.home.homes.myId)
      if (home.member || first) {
        out.push({
          id: 'home:mail',
          x: box.x,
          y: box.y + 2,
          label: home.member ? 'Check your mailbox' : `Leave something for ${short(first!.displayName || 'a neighbour', 16)}`,
          verb: 'Look',
          markerOffset: 16,
          activate: () => this.openMailbox()
        })
      }
      const door = { x: (L.door.tx + 1) * TILE, y: L.doorstep.ty * TILE + 4 }
      if (home.tier >= 1) {
        out.push({ id: 'home:door', ...door, label: home.member ? 'Go inside' : `Visit the cottage`, verb: 'Enter', markerOffset: 30, activate: () => void this.goInside() })
      } else if (home.member) {
        out.push({
          id: 'home:bed',
          x: L.origin.x + 96,
          y: L.origin.y + 52,
          label: () => `Rest at your bedroll · ${glimsCount(restCost())}`,
          verb: 'Rest',
          markerOffset: 16,
          activate: () => this.offerRest('Your bedroll')
        })
      }
      for (const it of home.items) {
        if (it.itemDef !== POST || it.scene !== 'outdoor' || it.x === null || it.y === null) continue
        out.push({
          id: `home:post:${it.id}`,
          x: (L.gridOrigin?.x ?? 0) + tileMid(it.x),
          y: (L.gridOrigin?.y ?? 0) + tileBottom(it.y) + 2,
          label: `Read the lamp${it.name ? `: ${short(it.name, 20)}` : ''}`,
          verb: 'Read',
          markerOffset: 36,
          activate: () => this.readPost(it.id)
        })
      }
      // A woodpile of yours on the land: stack green timber, collect seasoned.
      for (const it of home.items) {
        if (!home.member || !this.home.homes.connected) break
        if (it.itemDef !== 'woodpile' || it.scene !== 'outdoor' || it.x === null || it.y === null) continue
        out.push({
          id: `home:woodpile:${it.id}`,
          ...this.home.art.decoSpot(it, 'outdoor'),
          label: 'Tend the woodpile',
          verb: 'Stack',
          markerOffset: 16,
          activate: () =>
            !this.home.homes.connected || !this.home.here()?.member
              ? say('A woodpile', ['Green timber, stacked to season. “Green wood sinks, dry wood sings.”'])()
              : panel('woodpile')()
        })
      }
      out.push(...stablePoints(this.home, (speaker, lines) => this.say({ speaker, lines })))
      out.push(...this.seatPoints(home, 'outdoor'))
      return out
    }
    // Silas's Yard: Silas at his counter, Pell at the desk (the displays are the room's spots: ../room-spots.ts).
    if (this.home.yardRoom) return this.yardPeople()
    if (!this.home.commons) return out
    const f = this.home.commons.features
    const at = (t: { tx: number; ty: number }, dy = 0) => ({ x: tileMid(t.tx), y: tileBottom(t.ty) + dy })
    out.push(...this.yardPeople())
    out.push({
      id: 'home:hame',
      ...at(f.hame, 6),
      label: 'Look at the hame',
      verb: 'Look',
      markerOffset: 40,
      activate: say('The Commons Gate', [
        'A carter’s hame hangs on the gatepost: an empty collar, its brass polished bright. It hangs for the cart that never came home.',
        CARTING_DAY_NOTICE
      ])
    })
    out.push({
      id: 'home:well',
      ...at({ tx: f.well.tx, ty: f.well.ty }, 4),
      label: 'Look into the well',
      verb: 'Look',
      markerOffset: 44,
      activate: say('The Carters’ Well', ['The old staging well. Every cart filled its casks here before the lantern road. The rope is new; the bucket isn’t.'])
    })
    out.push({ id: 'home:toolbox', ...at(f.toolbox), label: 'Look in Silas’s toolbox', verb: 'Look', markerOffset: 16, activate: () => this.openToolbox() })
    out.push({ id: 'home:firebox', ...at(f.firebox, 2), label: 'Look at the firebox', verb: 'Look', markerOffset: 16, activate: () => this.lookInFirebox() })
    for (const slot of this.home.commons.gates) {
      out.push({ id: `home:sign:${slot.gate}`, ...at(slot.sign, 2), label: `Read the sign · ${lotName(slot.gate)}`, verb: 'Read', markerOffset: 16, activate: () => this.readSign(slot.gate) })
      const info = this.home.homes.gateInfo(slot.gate)
      if (info?.shelf) {
        out.push({ id: `home:shelf:${slot.gate}`, ...at(slot.shelf, 2), label: 'Look at the gift shelf', verb: 'Look', markerOffset: 16, activate: panel('shelf', slot.gate) })
      } else if (info?.mine) {
        const unplaced = this.home.homes.mine?.items.find((i) => i.itemDef === 'gate-shelf' && i.scene === null)
        if (unplaced) {
          out.push({ id: `home:place-shelf:${unplaced.id}`, ...at(slot.shelf, 2), label: 'Set out your gate shelf', verb: 'Place', markerOffset: 16, reach: 52, clickReach: 52, available: () => this.insideGate(slot.gate), activate: () => void this.placeGateShelf(unplaced.id) })
        }
      }
    }
    return out
  }

  /** The stake on an unclaimed lot. */
  private readStake(): void {
    const gate = this.home.gate!
    this.home.homes.chosenGate = gate
    this.say({
      speaker: lotName(gate),
      lines: [
        this.home.homes.connected
          ? 'A stake and a slate: UNCLAIMED. DEEDS FROM S. — THE YARD. Wild ground all round, but there’s a level patch here where a camp would sit.'
          : 'Wild ground, and a level patch where a camp would sit. Deeds are for people with a world: sign in to yours from the Menu.'
      ]
    })
  }

  /** Your mailbox, or a neighbour's: the mail panel (to them, on their land). */
  private openMailbox(): void {
    if (!this.home.homes.connected) return this.say({ speaker: 'Mailbox', lines: ['A carter’s post box. Parcels go between neighbours in a world. Sign in to yours from the Menu.'] })
    const home = this.home.here()
    const other = home?.members.find((m) => m.id !== this.home.homes.myId)
    bus.emit(EV.villageOpen, home?.member || !other ? { panel: 'mail' } : { panel: 'mail', to: other.id })
  }

  /** A lantern post on the land, and the name cut into it. */
  private readPost(itemId: string): void {
    const post = this.home.here()?.items.find((i) => i.id === itemId)
    this.say({
      speaker: post?.name ? `“${post.name}”` : 'A lantern post',
      lines: [post?.name ? `A lantern post, its name cut into the crossbar: ${post.name}. The ground stays put as far as its light reaches.` : 'A lantern post. Nobody has named it, and the dark doesn’t care about it.']
    })
  }

  /** Silas's toolbox (the first visit: a paper scratched on his tally-pouch). */
  private openToolbox(): void {
    this.deps.session.addFlag(HOME_FLAGS.met)
    const found = grantPaper(this.deps.session, PAPERS.toolbox)
    this.say({
      speaker: 'Silas’s Toolbox',
      lines: found
        ? ['Chisels wrapped in oilcloth, a fold rule, a tally-pouch gone soft with handling. Something is scratched on the pouch. You copy it out.']
        : ['Chisels in oilcloth, a fold rule, the tally-pouch. Everything clean. Rust is just iron forgetting it is a saw.']
    })
  }

  /** Silas's firebox (once the story's done and you have a cottage: a drawn-on offcut). */
  private lookInFirebox(): void {
    const ready = this.deps.session.questStage === 'complete' && (this.home.homes.mine?.tier ?? 0) >= 1
    if (ready && !this.deps.session.state.flags.includes(paperFlag(PAPERS.firebox))) {
      grantPaper(this.deps.session, PAPERS.firebox)
      return this.say({ speaker: 'Silas’s Firebox', lines: ['A wedge of pine offcut waits in the kindling box, charcoal all over it. Silas hasn’t burned this one. You take a careful look.'] })
    }
    this.say({ speaker: 'Silas’s Firebox', lines: ['The firebox ticks as it cools. A box of pine offcuts waits for kindling, every one of them drawn on.'] })
  }

  private readSign(gate: number): void {
    const info = this.home.homes.gateInfo(gate)
    if (!info || info.homeId === null) {
      this.home.homes.chosenGate = gate
      const price = info?.price
      this.say({
        speaker: lotName(gate),
        lines: [
          this.home.homes.status === 'guest'
            ? 'UNCLAIMED. Wild land past the gate. Deeds are for people with a world: sign in to yours from the Menu.'
            : `UNCLAIMED. Wild land past the gate. Deeds from S. at the yard${price === 0 ? ' — first deed on the Compact' : price ? ` — ${glimsCount(price)}` : ''}.`,
          'Walk through and have a look, if you like. The woods don’t mind.'
        ]
      })
      return
    }
    const names = info.names.length ? info.names.join(', ') : 'nobody now'
    const choices: DialogueChoice[] = []
    if (info.mine) {
      if (info.shelf) {
        choices.push({ text: 'Look at your gift shelf', action: `home:shelf:${gate}` })
      } else {
        const unplaced = this.home.homes.mine?.items.find((i) => i.itemDef === 'gate-shelf' && i.scene === null)
        if (unplaced) {
          choices.push({ text: 'Set out your gate shelf', action: `home:place-shelf:${unplaced.id}`, disabled: !this.insideGate(gate), ...(!this.insideGate(gate) ? { note: 'Step inside your gate' } : {}) })
        }
      }
    }
    this.say({
      speaker: lotName(gate),
      lines: [
        info.desolate
          ? `The paint has gone grey. You can just make out: ${names}. Nobody has lit the lamps back there in a while.`
          : info.mine
            ? `Your sign: ${names}. Silas cut the letters deep so the weather has to work for it.`
            : `${names}. A neighbour’s place: walk through to visit.`
      ],
      choices: choices.length ? choices : undefined
    })
  }

  private ownRoom(): boolean {
    return !!this.deps.room && !!this.home.here()?.member
  }

  private say(d: Dialogue): void {
    openDialogue({ id: 'home', speaker: d.speaker, lines: d.lines, choices: d.choices })
  }

  /** Silas and Pell, where their hour has them here (the Commons by the sawhorse, the shop's counter, Pell's desk). */
  private yardPeople(): Interactable[] {
    const out: Interactable[] = []
    for (const n of this.deps.world.npcs) {
      if (n.id !== 'silas' && n.id !== 'pell') continue
      const silas = n.id === 'silas'
      out.push({
        id: n.id,
        x: tileMid(n.tx),
        y: tileBottom(n.ty) - 4,
        label: `Talk to ${silas ? SILAS.name : PELL.name}`,
        verb: 'Talk',
        marker: () => (silas ? this.silasMarker() : this.pellMarker()),
        markerOffset: 24,
        // Across the counter (or Pell's desk) indoors: a little further than arm's length.
        ...(this.home.yardRoom ? { reach: 42 } : {}),
        activate: () => this.talkAtTheYard(silas ? 'silas' : 'pell')
      })
    }
    return out
  }

  /** "…" until you've met Silas. */
  private silasMarker(): MarkerKind {
    return this.deps.session.state.flags.includes(HOME_FLAGS.met) ? null : 'talk'
  }

  /** "!" while Pell has a deed (or an invite) for you; "…" until you've met. */
  private pellMarker(): MarkerKind {
    if (this.home.homes.connected && this.home.homes.status === 'ready' && (!this.home.homes.claimed || this.home.homes.inviteForMe())) return 'quest'
    return heardStory(this.deps.session.state.flags, 'pell', PELL_MET) ? null : 'talk'
  }

  /** Silas and Pell check the plot book first (who holds what, who wants a joint deed), then talk. */
  private talkAtTheYard(who: 'silas' | 'pell'): void {
    const now = () => (who === 'silas' ? this.talkToSilasNow() : this.talkToPellNow())
    if (this.home.homes.connected && this.home.homes.status === 'ready') {
      // The world holds still while they read (the scene's end lets go, never this late answer).
      this.silasHold.take()
      void this.home.homes.load().finally(() => {
        if (this.home.gone) return
        this.silasHold.settle()
        now()
      })
      return
    }
    now()
  }

  /** Silas's short talk (silas-yard.md 2.2): the same at his counter and out in the yard. */
  private talkToSilasNow(): void {
    const s = this.deps.session
    const homes = this.home.homes
    const first = !s.state.flags.includes(HOME_FLAGS.met)
    s.addFlag(HOME_FLAGS.met)
    // The axe is offered only when Silas can hand it over now (the server's
    // checks, from where you stand); otherwise he says why instead.
    const beat = homes.connected ? heirloomBeat(s, 'brack-felling-axe', 'Take the Brack felling axe') : null
    const fox = keepsakeAsk('silas', s.state.flags, itemsFor(s).view?.stacks.map((x) => x.itemDef) ?? [])
    const talk = silasTalk({
      first,
      idle: SILAS.dialogue.idleLines[this.nextIdle()],
      connected: homes.connected,
      claimed: homes.status === 'ready' ? homes.claimed : null,
      axe: beat ? { lines: beat.lines, choice: beat.choices[0] ?? null } : null,
      guestAxe: !homes.connected && knowsHollisName(s.state.flags, s.questStage) && !s.state.flags.includes('heirloom:brack-felling-axe'),
      fox
    })
    this.say(talk)
    // No deed yet: the needle points at Pell (the claim guide), the first
    // time only, and never over something you've pinned yourself.
    if (talk.pointsAtPell && homes.connected && !heardStory(s.state.flags, 'silas', SILAS_PINNED_PELL)) {
      markStory(s, 'silas', SILAS_PINNED_PELL)
      if (!pinned.slot) setPinned('guide:claim')
    }
    if (homes.connected && homes.status !== 'ready' && homes.status !== 'loading') void homes.load()
  }

  /** Pell at the desk (silas-yard.md 2.6): deed things only. */
  private talkToPellNow(): void {
    const s = this.deps.session
    const homes = this.home.homes
    const first = !heardStory(s.state.flags, 'pell', PELL_MET)
    const invite = homes.inviteForMe()
    const talk = pellTalk({
      first,
      idle: PELL.idleLines[this.nextPellIdle()],
      status: homes.connected ? homes.status : 'guest',
      claimed: homes.claimed,
      homeRead: !!homes.mine,
      glims: s.state.glims,
      invite: invite ? { homeId: invite.homeId, gate: invite.gate, from: invite.from.name } : null,
      reclaimable: homes.reclaimable().map((g) => g.gate),
      unclaimed: homes.unclaimed().map((g) => ({ gate: g.gate, price: g.price ?? HOMESTEAD_DATA.deeds.glims })),
      pitchHeard: heardStory(s.state.flags, 'pell', PELL_PITCH),
      atTable: standsAtTable(s.state.area, this.deps.hero())
    })
    if (talk.met) markStory(s, 'pell', PELL_MET)
    // The pitch (or the first meeting, which says the same) plays once.
    if (homes.status === 'ready' && !homes.claimed) markStory(s, 'pell', PELL_PITCH)
    this.say(talk)
    if (talk.needsRead) void homes.load()
  }

  private nextIdle(): number {
    this.idleLine = (this.idleLine + 1) % SILAS.dialogue.idleLines.length
    return this.idleLine
  }

  private nextPellIdle(): number {
    this.pellLine = (this.pellLine + 1) % PELL.idleLines.length
    return this.pellLine
  }

  private offerRest(speaker: string): void {
    const s = this.deps.session
    const check = s.checkSpend({ kind: 'home-rest' })
    const offline = s.link && !s.link.online
    const choice: DialogueChoice = offline
      ? { text: 'Rest a while', note: 'Needs a connection', disabled: true }
      : check.ok
        ? { text: 'Rest a while', note: glimsCount(check.cost), action: 'home-rest' }
        : { text: 'Rest a while', note: check.reason === 'full' ? 'Already rested' : check.reason === 'needs-earned' ? `Needs ${glimsCount(check.cost)} earned on Habitica` : `Needs ${glimsCount(check.cost)}`, disabled: true }
    this.say({
      speaker,
      lines: [speaker === 'Your bedroll'
        ? 'The cot is up off the ground on its blocks, the way the pamphlets say. The fire’s banked. Your own lamp keeps the dark off.'
        : 'Your own hearth, banked low. The floor creaks the way Silas promised.'],
      choices: [choice, { text: 'Not now' }]
    })
  }

  private async goInside(): Promise<void> {
    if (!this.home.land) return
    this.deps.enterRoom(this.home.land.gate, this.home.land.doorstep)
  }

  /** A choice picked in a homestead conversation. */
  async onAction(action: string): Promise<void> {
    if (action.startsWith('home:shelf:')) {
      const gate = Number(action.slice('home:shelf:'.length))
      bus.emit(EV.villageOpen, { panel: 'shelf', gate })
      return
    }
    if (action.startsWith('home:place-shelf:')) return this.placeGateShelf(action.slice('home:place-shelf:'.length))
    if (action.startsWith('home:claim:')) return this.claim(Number(action.slice('home:claim:'.length)))
    if (action.startsWith('home:sign:')) return this.signDeed(action.slice('home:sign:'.length))
    if (action === SEE_THE_YARD) return openYard()
    if (action === MANAGE_DEED) return openDeedPanel()
  }

  private insideGate(gate: number): boolean {
    const p = this.deps.hero()
    return this.deps.world.areaId === 'outdoors' && lotAtPixel(p.x,p.y) === gate
  }

  private async placeGateShelf(itemId: string): Promise<void> {
    const gate = this.home.homes.myGate
    if (gate === null || !this.insideGate(gate)) {
      this.say({ speaker: 'Gate Shelf', lines: ['Step inside your gate to set out the shelf.'] })
      return
    }
    bus.emit(EV.notePosition)
    const r = await this.home.homes.act({ op: 'place', itemId, scene: 'gate', x: 0, y: 0, rotation: 0 })
    if (r.ok) {
      sfx('pop')
      this.deps.rebuild()
    } else {
      sfx('fizzle')
      this.say({ speaker: 'Gate Shelf', lines: [r.text] })
    }
  }

  /** Pell enters your name: a new deed, or an old one taken back. */
  private async claim(gate: number): Promise<void> {
    const back = this.home.homes.gateInfo(gate)?.reclaim ?? false
    const price = this.home.homes.gateInfo(gate)?.price ?? HOMESTEAD_DATA.deeds.glims
    const r = await this.home.homes.claim(gate)
    if (!this.scene.sys.isActive()) return
    if (!r.ok) {
      this.say({ speaker: PELL.name, lines: [r.code === 'insufficient-glims' ? PELL_DEED.notEnoughGlims : r.text] })
      return
    }
    sfx('quest')
    this.home.scheduleRedraw()
    if (back) {
      this.say({ speaker: PELL.name, lines: [PELL_DEED.takenBack(lotName(gate))] })
      bus.emit(EV.toast, { text: `${lotName(gate)} is yours again.`, icon: 'lantern' })
      return
    }
    this.say({ speaker: PELL.name, lines: [PELL_DEED.bought(lotName(gate), price)] })
    bus.emit(EV.toast, { text: isYardRoom(this.deps.session.state.area) ? `${lotName(gate)} is yours. Your gate is out on the lane: follow the marker.` : `${lotName(gate)} is yours. Follow the marker to your gate.`, icon: 'lantern' })
  }

  /** Your signature on someone's deed, at the table in Pell's office. */
  private async signDeed(homeId: string): Promise<void> {
    const me = this.home.homes.myId
    if (!me) return
    const r = await this.home.homes.sign(homeId, me)
    if (!this.scene.sys.isActive()) return
    if (!r.ok) {
      this.say({ speaker: PELL.name, lines: [r.text] })
      return
    }
    if (r.status === 'joined') {
      sfx('quest')
      this.home.scheduleRedraw()
      this.say({ speaker: PELL.name, lines: [PELL_DEED.signedTogether] })
      return
    }
    this.say({ speaker: PELL.name, lines: [PELL_DEED.signedWaiting(HOMESTEAD_DATA.jointDeed.confirmWindowSeconds)] })
  }
}
