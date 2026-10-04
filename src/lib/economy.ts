/** Shared economy contract; JSON is validated by both language test suites. */
export interface Economy {
  xpPerEmber: number;
  welcomeEmbers: number;
  costs: { rest: number; roadLantern: number; chest: number };
  questEmbers: Partial<Record<import('./state.ts').QuestEvent, number>>;
  roadLanterns: readonly ['road-1', 'road-2', 'road-3'];
  chestId: string;
  charmItem: string;
  syncCreditCap: number;
  migrationGiftCap: number;
  checkpointToleranceXp: number;
}
