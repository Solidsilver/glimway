/**
 * Types of the Wilds' shared data (content/wilds.json), read on both sides:
 * the server's generator (server/internal/wilds) and the client's loader
 * (data.ts). The client never generates the Wilds; it reads served chunks.
 * The generated messages (proto/glimway/content/v1/wilds.proto) carry the
 * schema; these are the narrowed views the loaders export.
 */

import type {
  WildsValid,
  WildsEntityKindRuleValid,
  WildsGroundValid,
  WildsPlaceValid,
} from '../gen/glimway/content/v1/wilds_pb.js';

export type WildsEntityKind = 'camp' | 'node' | 'chest' | 'poi';
/** What players may do on a ground (open-map.md section 3). */
export type WildsSurface = 'land' | 'water' | 'ford' | 'road' | 'laid';
/** A footprint's epoch: the Tangle's never turns, the Beyond's every wick. */
export type WildsEpochKind = 'still' | 'wick';

// ------------------------------------------------------------- shared data

export type WildsEntityKindRule = Omit<WildsEntityKindRuleValid, 'kind'> & { kind: WildsEntityKind };
export type WildsGround = Omit<WildsGroundValid, 'surface'> & { surface: WildsSurface };
export type WildsPlace = Omit<WildsPlaceValid, 'look' | 'epochKind'> & { look: 'tangle' | 'outer'; epochKind: WildsEpochKind };

/** The validated file, with the schema's vocabularies narrowed once. */
export type WildsData = Omit<WildsValid, 'entityKinds' | 'grounds' | 'places'> & {
  entityKinds: WildsEntityKindRule[];
  grounds: WildsGround[];
  places: WildsPlace[];
};
