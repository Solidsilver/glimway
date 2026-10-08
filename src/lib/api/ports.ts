export const LANTERN_ROAD = 'lantern-road';
export const LANTERN_ROAD_STEPS = ['accepted', 'clue-found', 'guardian-defeated', 'lantern-lit', 'complete'] as const;
export interface PaperRule { kind: string; area?: string; tx?: number; ty?: number; after?: string; stage?: string; from?: string; project?: string; fact?: string; poi?: string; site?: string; member?: string; paper?: string; roadLit?: boolean; east?: boolean; mark?: string; tier?: number; unbuilt?: boolean; }
export interface QuestStep { id: string; at: string; items: string[]; marks: string[]; papers: string[]; embers: number; witness: string; }
