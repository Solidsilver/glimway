/**
 * Homesteads, talked to: everything you can use on the Commons, on a
 * homestead's land and in a cottage (each point with its own prompt and
 * action), Silas's deeds and upgrades at his table, the deed's sharing and
 * leaving, resting at home, and the placed seats.
 */
import Phaser from 'phaser'
import { HOMESTEAD_DATA, type HomeScene } from '../../lib/homestead'
import { checkSpend } from '../../lib/embers'
import type { HomeView } from '../../lib/api/types'
import { CARTING_DAY_NOTICE } from '../../content/expansion-writing'
import type { Dialogue, DialogueChoice } from '../../content/world'
import { shortTalk } from '../../content/talk'
import { heardStory, markStory } from '../heard'
import { paperFlag } from '../../content/papers'
import { HEIRLOOM_GUEST_LINES, knowsHollisName } from '../../content/heirlooms'
import { heirloomBeat } from '../heirloom-beats'
import { EMPTY_CHAIR_LINE, SEAT_LINES } from '../../content/touches'
import { KEPT_EMPTY, isSeatItem } from '../seats'
import { bus, EV } from '../events'
import { uiState } from '../input'
import { sfx } from '../sfx'
import { TILE, tileBottom, tileMid } from '../../lib/tile'
import { ROOM_BENCH, ROOM_CHEST, ROOM_HEARTH } from '../cottage'
import { grantPaper } from '../papers'
import { presence } from '../presence'
import { itemsFor } from '../items'
import { sellerFor } from '../../lib/items'
import { sellerChoices } from '../../lib/purse'
import { purseCopy } from '../../content/purse'
import { keepsakeAsk } from '../keepsakes'
import type { VillagePanel } from '../village'
import { openBoard } from './village-life'
import { costPhrase, WORKSHOP_TIER, workshopShort } from '../../lib/village'
import { HOME_FLAGS, PAPERS, SILAS, lotName } from '../homestead'
import { homeErrorText } from '../../content/errors'
import type { Interactable, MarkerKind } from './interactables'
import { DialogueHold } from '../dialogue-hold'
import { stablePoints } from './homestead-stable'
import { openDialogue } from '../dialogue'
import type { HomesteadDeps, HomesteadLayer } from './homesteads'
import { POST, SILAS_ID, short } from './homestead-art'

/** "30 embers, 20 timber, 10 stone, 8 fiber" */
function workshopPrice(): string {
  return `${WORKSHOP_TIER.embers} embers, ${costPhrase(WORKSHOP_TIER.materials ?? {})}`
}

export class HomesteadTalk {
  private readonly scene: Phaser.Scene
  private readonly deps: HomesteadDeps

  private idleLine = Math.floor(Math.random() * SILAS.dialogue.idleLines.length)
  /** The next sit line for a placed seat (cycling). */
  private seatLine = 0
  /** The world held still while Silas reads his plot book. */
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
        label: () => (this.ownRoom() ? `Rest by your hearth · ${restCost()} ember` : 'Sit by the hearth'),
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
          x: (L.site.x + L.site.w / 2) * TILE,
          y: (L.site.y + L.site.h - 1) * TILE + 2,
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
          label: () => `Rest at your bedroll · ${restCost()} ember`,
          verb: 'Rest',
          markerOffset: 16,
          activate: () => this.offerRest('Your bedroll')
        })
      }
      for (const it of home.items) {
        if (it.itemDef !== POST || it.scene !== 'outdoor' || it.x === null || it.y === null) continue
        out.push({
          id: `home:post:${it.id}`,
          x: tileMid(it.x),
          y: tileBottom(it.y) + 2,
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
    if (!this.home.commons) return out
    const f = this.home.commons.features
    const at = (t: { tx: number; ty: number }, dy = 0) => ({ x: tileMid(t.tx), y: tileBottom(t.ty) + dy })
    out.push({ id: SILAS_ID, ...at(f.silas, -4), label: 'Talk to Silas', verb: 'Talk', marker: () => this.silasMarker(), markerOffset: 24, activate: () => this.talkToSilas() })
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
    out.push({ id: 'home:board', ...at(f.board, 2), label: 'Read the notice board', verb: 'Look', markerOffset: 32, activate: openBoard })
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
          out.push({ id: `home:place-shelf:${unplaced.id}`, ...at(slot.shelf, 2), label: 'Set out your gate shelf', verb: 'Place', markerOffset: 16, activate: () => void this.placeGateShelf(unplaced.id) })
        }
      }
    }
    return out
  }

  /** "!" while Silas has a deed (or an invite) for you; "…" until you've met him. */
  private silasMarker(): MarkerKind {
    if (this.home.homes.connected && this.home.homes.status === 'ready' && (!this.home.homes.claimed || this.home.homes.inviteForMe())) return 'quest'
    if (!this.deps.session.state.flags.includes(HOME_FLAGS.met)) return 'talk'
    return null
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
            : `UNCLAIMED. Wild land past the gate. Deeds from S. at the yard${price === 0 ? ' — first deed on the Compact' : price ? ` — ${price} embers` : ''}.`,
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
          choices.push({ text: 'Set out your gate shelf', action: `home:place-shelf:${unplaced.id}` })
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

  /** `yard`: his yard talk (talkToSilasNow), where his offcut bundles are on offer. */
  private say(d: Dialogue, opts: { yard?: boolean } = {}): void {
    // Carrying Hollis's fox adds the quiet line (give it back / not yet).
    let lines = d.lines
    let choices = d.choices
    if (d.speaker === SILAS.name) {
      const ask = keepsakeAsk('silas', this.deps.session.state.flags, itemsFor(this.deps.session).view?.stacks.map((s) => s.itemDef) ?? [])
      if (ask) {
        lines = [...lines, ask.line]
        choices = [...(choices ?? []), ...ask.choices]
      }
      // His yard's offcut bundles, for gold only (purse-and-wardrobe.md 3.1), before the goodbye.
      const yard = opts.yard && this.deps.session.link ? sellerFor('silas-yard') : null
      if (yard) {
        const bundles = sellerChoices(yard, { reply: true })
        const list = choices ?? []
        const last = list.at(-1)
        const bye = last && !last.action && !last.disabled && !last.replay ? last : null
        choices = bye ? [...list.slice(0, -1), ...bundles, bye] : [...list, ...bundles, { text: purseCopy.notYet }]
      }
    }
    openDialogue({ id: 'home', speaker: d.speaker, lines, choices })
  }

  /** Who stands at Silas's table right now (presence, this world), but you. */
  private atTable(): { id: string; name: string }[] {
    const feed = presence()
    if (!feed) return []
    const t = HOMESTEAD_DATA.commons.silasTable
    const now = performance.now()
    const out: { id: string; name: string }[] = []
    for (const p of feed.peersIn('commons')) {
      if (p.leftAt !== null) continue
      const at = p.track.at(now)
      if (at && Math.hypot(at.x - t.x, at.y - t.y) <= t.radius) out.push({ id: p.accountId, name: p.displayName || 'A neighbour' })
    }
    return out
  }

  private heroAtTable(): boolean {
    const t = HOMESTEAD_DATA.commons.silasTable
    const h = this.deps.hero()
    return Math.hypot(h.x - t.x, h.y - t.y) <= t.radius
  }

  /** Silas checks his plot book first (who holds what, who wants a joint deed), then talks. */
  private talkToSilas(): void {
    if (this.home.homes.connected && this.home.homes.status === 'ready') {
      // The world holds still while he reads (the scene's end lets go, never this late answer).
      this.silasHold.take()
      void this.home.homes.load().finally(() => {
        if (this.home.gone) return
        this.silasHold.settle()
        this.talkToSilasNow()
      })
      return
    }
    this.talkToSilasNow()
  }

  private talkToSilasNow(): void {
    const s = this.deps.session
    const lines = SILAS.dialogue
    const first = !s.state.flags.includes(HOME_FLAGS.met)
    s.addFlag(HOME_FLAGS.met)

    // The axe is offered only when Silas can hand it over now (the server's
    // checks, from where you stand); otherwise he says why instead.
    const axe = this.home.homes.connected ? heirloomBeat(s, 'brack-felling-axe', 'Take the Brack felling axe') : null
    const canAxe = !!axe?.choices.length
    const axeChoice = axe?.choices[0] as DialogueChoice
    const axeLines = axe?.lines ?? []

    if (!this.home.homes.connected) {
      const guestAxe = knowsHollisName(s.state.flags, s.questStage) && !s.state.flags.includes('heirloom:brack-felling-axe')
      const deeds = ['Deeds out here are for folk with a world, mind. Sign in to your world and I’ll sell you one. Land past any gate on the lane.']
      const told = this.toldBefore('guest', first, deeds)
      this.say({
        speaker: SILAS.name,
        lines: [
          ...(first ? lines.firstMeeting.lines : [lines.idleLines[this.nextIdle()]]),
          ...(guestAxe ? [HEIRLOOM_GUEST_LINES.silas] : []),
          ...told.lines
        ],
        choices: told.choices
      })
      return
    }
    if (this.home.homes.status !== 'ready') {
      const choices: DialogueChoice[] = canAxe ? [axeChoice, { text: 'Not yet' }] : []
      this.say({
        speaker: SILAS.name,
        lines: [
          ...(first ? lines.firstMeeting.lines : []),
          ...axeLines,
          this.home.homes.status === 'offline'
            ? 'Can’t make out the plot book just now. Weather, likely. Come back when the road to your world is clear.'
            : 'Hold on, I’m finding your page in the plot book.'
        ],
        choices: choices.length ? choices : undefined
      })
      if (this.home.homes.status !== 'loading') void this.home.homes.load()
      return
    }
    const mine = this.home.homes.mine
    if (!this.home.homes.claimed) {
      const invite = this.home.homes.inviteForMe()
      const choices: DialogueChoice[] = []
      if (canAxe) choices.push(axeChoice)
      if (invite) choices.push({ text: `Sign ${short(invite.from.name, 14)}’s deed`, note: `${lotName(invite.gate)} · together, at the table`, action: `home:sign:${invite.homeId}` })
      for (const g of this.home.homes.reclaimable().slice(0, 2)) choices.push({ text: `Take back ${lotName(g.gate)}`, note: 'Your old deed, as it stands · free', action: `home:claim:${g.gate}` })
      for (const g of this.home.homes.unclaimed().slice(0, 4)) {
        const price = g.price ?? HOMESTEAD_DATA.deeds.embers
        const short = price > s.state.embers
        choices.push(short ? { text: `The deed to ${lotName(g.gate)}`, note: `Needs ${price} embers`, disabled: true } : { text: `The deed to ${lotName(g.gate)}`, note: price === 0 ? 'First deed: on the Compact' : `${price} embers`, action: `home:claim:${g.gate}` })
      }
      choices.push({ text: 'Not yet' })
      // An invite or an old page is news every time; the lantern-light speech plays once.
      const pitch = invite
        ? [`${invite.from.name} wants your name on their deed, ${lotName(invite.gate)}. Both of you here at my table, both of you sign, and it’s done.`]
        : this.home.homes.reclaimable().length
          ? [`Your old page’s still in the book: ${lotName(this.home.homes.reclaimable()[0].gate)}. Nobody’s struck it out. Say the word and your name goes back on, or pick fresh land.`]
          : null
      const told = pitch ? { lines: pitch, choices } : this.toldBefore('unclaimed', first, ['I measure land in lantern-light, not yards. Pick a gate on the lane, read the sign, walk the ground if you like. Then I’ll draw you the deed.'], choices)
      this.say({
        speaker: SILAS.name,
        lines: [
          ...(first ? lines.firstMeeting.lines : ['There you are, neighbour.']),
          ...axeLines,
          ...told.lines
        ],
        choices: told.choices
      }, { yard: true })
      return
    }
    if (!mine) {
      const choices: DialogueChoice[] = canAxe ? [axeChoice, { text: 'Not yet' }] : []
      this.say({
        speaker: SILAS.name,
        lines: [
          ...(first ? lines.firstMeeting.lines : []),
          ...axeLines,
          'Hold on, I’m finding your page in the plot book.'
        ],
        choices: choices.length ? choices : undefined
      })
      void this.home.homes.load()
      return
    }
    const choices: DialogueChoice[] = []
    if (canAxe) choices.push(axeChoice)
    if (mine.tier === 0) {
      const cost = this.home.homes.cottagePrice()
      const short = s.state.embers < cost
      choices.push(short ? { text: 'Raise a cottage', note: `Needs ${cost} embers`, disabled: true } : { text: 'Raise a cottage', note: `${cost} embers`, action: 'home:upgrade' })
    }
    if (mine.tier === 1) {
      const why = workshopShort(s.state.embers, this.home.homes.materials)
      choices.push(why ? { text: 'Build on a workshop', note: why, disabled: true } : { text: 'Build on a workshop', note: workshopPrice(), action: 'home:upgrade' })
    }
    choices.push({ text: 'See what you’ve finished', action: 'home:shop' })
    choices.push({ text: 'Share the deed', note: 'Someone at the table with you', action: 'home:share' })
    choices.push({ text: 'Give up my place on the deed', action: 'home:leave' })
    choices.push({ text: canAxe ? 'Not yet' : 'Just passing' })
    const intro = mine.tier === 0
      ? [s.state.embers < this.home.homes.cottagePrice() ? lines.notEnoughEmbers.lines[0] : 'Your camp’s holding. Four skids and a slate roof, and you’d have a door to hang a fox over. Say the word.']
      : mine.tier === 1
        ? ['Deep eaves, a heavy bench and a chest that doesn’t drink the damp. Bring me timber, stone and fiber from the Wilds and I’ll build you a workshop.', lines.sellDecorations.lines[0]]
        : [lines.sellDecorations.lines[0]]
    // What he says about your place plays once per state; then a nod and "Hear it again".
    const state = mine.tier === 0 ? `tier:0:${s.state.embers < this.home.homes.cottagePrice() ? 'saving' : 'ready'}` : `tier:${mine.tier}`
    const told = this.toldBefore(state, first, intro, choices)
    const greet = first ? lines.firstMeeting.lines : mine.tier === 0 && !told.short ? [] : [lines.idleLines[this.nextIdle()]]
    this.say({
      speaker: SILAS.name,
      lines: [...greet, ...axeLines, ...told.lines],
      choices: told.choices
    }, { yard: true })
  }

  /**
   * Silas's say about something plays in full once (src/game/heard.ts);
   * after that he leaves it out and offers "Hear it again" among the choices.
   */
  private toldBefore(what: string, first: boolean, lines: string[], choices?: DialogueChoice[]): { lines: string[]; choices: DialogueChoice[] | undefined; short: boolean } {
    const s = this.deps.session
    const heard = !first && heardStory(s.state.flags, 'silas', what)
    markStory(s, 'silas', what)
    if (!heard) return { lines, choices, short: false }
    const t = shortTalk({ greeting: '', fresh: [], full: lines, choices })
    return { lines: [], choices: t.choices, short: true }
  }

  private nextIdle(): number {
    this.idleLine = (this.idleLine + 1) % SILAS.dialogue.idleLines.length
    return this.idleLine
  }

  private offerRest(speaker: string): void {
    const s = this.deps.session
    const check = s.checkSpend({ kind: 'home-rest' })
    const offline = s.link && !s.link.online
    const choice: DialogueChoice = offline
      ? { text: 'Rest a while', note: 'Needs a connection', disabled: true }
      : check.ok
        ? { text: 'Rest a while', note: `${check.cost} ember`, action: 'home-rest' }
        : { text: 'Rest a while', note: check.reason === 'full' ? 'Already rested' : check.reason === 'needs-earned' ? `Needs ${check.cost} ember earned on Habitica` : `Needs ${check.cost} ember`, disabled: true }
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
    if (action.startsWith('home:offer:')) return this.offerDeed(action.slice('home:offer:'.length))
    if (action === 'home:share') return this.share()
    if (action === 'home:leave') {
      bus.emit(EV.homeConfirmLeave, { place: this.home.placeName(this.home.homes.mine, this.home.homes.myGate ?? 0), shared: (this.home.homes.mine?.members.length ?? 1) > 1 })
      return
    }
    if (action === 'home:leave-confirmed') return this.leave()
    if (action === 'home:shop') {
      bus.emit(EV.homeShop)
      return
    }
    if (action === 'home:upgrade') {
      const r = await this.home.homes.upgrade()
      if (!this.scene.sys.isActive()) return
      if (r.ok) {
        sfx('lantern')
        const workshop = (this.home.homes.mine?.tier ?? 0) >= 2
        this.say({
          speaker: SILAS.name,
          lines: workshop
            ? ['There. Deep eaves, a heavy bench, and a chest that won’t drink the damp. Clean your tools. Rust is just iron forgetting it is a saw.']
            : [...SILAS.dialogue.afterUpgrade.lines.map((l) => l.replace('Go on in.', 'It’s up on your land, past your gate. Go on in.'))]
        })
      } else if (r.code === 'insufficient-embers') {
        this.say({ speaker: SILAS.name, lines: SILAS.dialogue.notEnoughEmbers.lines })
      } else {
        bus.emit(EV.toast, { text: r.text, kind: 'error' })
      }
    }
  }

  private async placeGateShelf(itemId: string): Promise<void> {
    const r = await this.home.homes.act({ op: 'place', itemId, scene: 'gate', x: 0, y: 0, rotation: 0 })
    if (r.ok) {
      sfx('pop')
      this.deps.rebuild()
    } else {
      sfx('fizzle')
      this.say({ speaker: 'Gate Shelf', lines: [r.text] })
    }
  }

  private async claim(gate: number): Promise<void> {
    const back = this.home.homes.gateInfo(gate)?.reclaim ?? false
    const r = await this.home.homes.claim(gate)
    if (!this.scene.sys.isActive()) return
    if (!r.ok) {
      this.say({ speaker: SILAS.name, lines: [r.code === 'insufficient-embers' ? SILAS.dialogue.notEnoughEmbers.lines[0] : r.text] })
      return
    }
    sfx('quest')
    this.home.scheduleRedraw()
    if (back) {
      this.say({ speaker: SILAS.name, lines: [`There. Your name’s back on ${lotName(gate)}, same ink. It’s all as you left it, give or take the weeds.`] })
      bus.emit(EV.toast, { text: `${lotName(gate)} is yours again.`, icon: 'lantern' })
      return
    }
    this.say({
      speaker: SILAS.name,
      lines: [
        ...SILAS.dialogue.offerCampsite.lines,
        `There: ${lotName(gate)}, in my square hand, measured in lantern-light. Your camp’s set up past the gate. Follow the lane; you’ll see your sign.`
      ]
    })
    bus.emit(EV.toast, { text: `${lotName(gate)} is yours. Follow the marker to your gate.`, icon: 'lantern' })
  }

  private async leave(): Promise<void> {
    const r = await this.home.homes.leave()
    if (!this.scene.sys.isActive()) return
    if (!r.ok) {
      bus.emit(EV.toast, { text: r.text, kind: 'error' })
      return
    }
    this.home.scheduleRedraw()
    this.say({
      speaker: SILAS.name,
      lines: ['I’ll strike your name. What’s in your pack is yours, and your own chest goes with you. The rest stays with the land.', 'Plenty of gates on the lane when you’re ready.']
    })
  }

  /** Who could share the deed: everyone else standing at Silas's table. */
  private share(): void {
    if (!this.heroAtTable()) {
      this.say({ speaker: SILAS.name, lines: [homeErrorText('not-at-table')] })
      return
    }
    const here = this.atTable()
    const members = new Set(this.home.homes.mine?.members.map((m) => m.id) ?? [])
    const candidates = here.filter((p) => !members.has(p.id)).slice(0, 4)
    if (candidates.length === 0) {
      this.say({ speaker: SILAS.name, lines: ['Both names go on together, and both of you sign here at my table. Bring them by. I’ll wait. I’m good at it.'] })
      return
    }
    this.say({
      speaker: SILAS.name,
      lines: ['A joint deed, then. Same land, same say, both names. Who’s it to be?'],
      choices: [...candidates.map((p) => ({ text: short(p.name, 22), note: 'Sign together', action: `home:offer:${p.id}` })), { text: 'Not now' }]
    })
  }

  private async offerDeed(to: string): Promise<void> {
    const r = await this.home.homes.offerDeed(to)
    if (!this.scene.sys.isActive()) return
    if (!r.ok) {
      this.say({ speaker: SILAS.name, lines: [r.text] })
      return
    }
    this.deedAnswer(r.status)
  }

  private async signDeed(homeId: string): Promise<void> {
    const me = this.home.homes.myId
    if (!me) return
    const r = await this.home.homes.sign(homeId, me)
    if (!this.scene.sys.isActive()) return
    if (!r.ok) {
      this.say({ speaker: SILAS.name, lines: [r.text] })
      return
    }
    this.deedAnswer(r.status)
  }

  private deedAnswer(status: 'joined' | 'waiting' | undefined): void {
    if (status === 'joined') {
      sfx('quest')
      this.home.scheduleRedraw()
      this.say({ speaker: SILAS.name, lines: ['There. Both names, same land, same say. Mind you both keep the lamps lit.'] })
      return
    }
    const window = HOMESTEAD_DATA.jointDeed.confirmWindowSeconds
    this.say({ speaker: SILAS.name, lines: [`Your name’s down. Now the other one signs, here at the table. I’ll hold the ink about ${window >= 60 ? `${Math.round(window / 60)} minute${window >= 120 ? 's' : ''}` : `${window} seconds`}.`] })
  }

}
