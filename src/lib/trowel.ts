/**
 * The trowel (content `bench-trowel`, tool action `uproot`): the one way to
 * dig up something planted, on your own land, in its lit backland or at a
 * camp. With the trowel in hand, a plant you may dig answers with "Dig up";
 * without it no plant offers digging, so plants' prompts stay plain. It
 * comes up whole, roots and all, into your pack, its growth kept, to plant
 * again (src/lib/inventory.ts carriedPlantEntry). The server decides who may
 * (api/camp_teardown.go digUpPlant). No Phaser, no network.
 */
import type { BeltKind } from './belt.ts'
import { wearLine } from './gathering.ts'

/** The belt kind the trowel fills. */
export const TROWEL: BeltKind = 'uproot'

interface PlantOffer {
  label: string
  verb: string
  /** True: pressing digs it up. False: pressing looks at it. */
  dig: boolean
}

/**
 * What pressing at a plant does: dig it up, with the trowel in hand and
 * leave to dig; otherwise look at it where looking is offered (a camp), or
 * nothing (null).
 */
export function plantOffer(plant: string, held: BeltKind, mayDig: boolean, mayLook: boolean): PlantOffer | null {
  const name = plant.toLowerCase()
  if (held === TROWEL && mayDig) return { label: `Dig up the ${name}`, verb: 'Dig up', dig: true }
  return mayLook ? { label: `Look at the ${name}`, verb: 'Look', dig: false } : null
}

/** Said once it's dug up: lifted whole, into the pack as the plant itself. */
export function uprootedLine(plant: string): string {
  return `You lift the ${plant.toLowerCase()} whole, roots and all. It’s in your pack, ready to plant again.`
}

/**
 * Said once it's dug up, with what the dig did to the trowel when that's
 * worth a word: each dig is one use, and a trowel at zero gives out as any
 * cheap tool does (./gathering.ts wearLine).
 */
export function dugUpLine(plant: string, wear: Parameters<typeof wearLine>[0]): string {
  const worn = wearLine(wear)
  return worn ? `${uprootedLine(plant)} ${worn}` : uprootedLine(plant)
}
