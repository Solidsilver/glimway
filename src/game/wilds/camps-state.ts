import type { CampView } from '../../lib/gen/glimway/v1/camps_pb.js'

/**
 * The world's camps as the open map last read them (./camps.ts writes it),
 * so the pack can offer to set a lamp, a piece or a seed down at the camp
 * you stand in. Read when the pack draws; not reactive.
 */
export const campsKnown: { list: CampView[]; me: string | null } = { list: [], me: null }
