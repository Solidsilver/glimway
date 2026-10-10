export interface PaperRule { kind: string; area?: string; tx?: number; ty?: number; after?: string; stage?: string; from?: string; project?: string; fact?: string; poi?: string; site?: string; member?: string; paper?: string; roadLit?: boolean; east?: boolean; mark?: string; tier?: number; unbuilt?: boolean; }
export type QuestTrigger = { talk: string } | { use: string } | { reach: string } | { defeat: string } | { carry: string } | { flag: string } | { open: 'journal' } | { sync: 'glims' };
export type QuestStart = QuestTrigger | { new: true };
export interface QuestWhere { area?: string; npc?: string; spot?: string; enemy?: string; ui?: 'journal' }
export interface QuestItem { def: string; qty: number }
export interface QuestGate { with?: string; wait?: { hours: number } | { turnings: number }; item?: QuestItem & { keep: boolean }; embers?: number }
export interface QuestStep {
  id: string; at: string; items: string[]; marks: string[]; papers: string[]; embers: number; witness: string;
  goal?: string; objective?: string; where?: QuestWhere; do: QuestTrigger; gate?: QuestGate; give?: QuestItem[];
  note?: { title: string; body: string }; moment?: { eyebrow: string; title: string };
}
