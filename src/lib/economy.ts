/** Shared economy contract; JSON is validated by both language test suites. */
export interface Economy {
  xpPerEmber: number;
  welcomeEmbers: number;
  costs: { homeRest: number; rest: number; roadLantern: number; chest: number };
  questEmbers: Partial<Record<import('./state.ts').QuestEvent, number>>;
  roadLanterns: readonly ['road-1', 'road-2', 'road-3'];
  chestId: string;
  charmItem: string;
  syncCreditCap: number;
  syncCreditDailyGrowth: number;
  syncCreditMax: number;
  pendingCreditDays: number;
  lifetimeInvites: number;
  wildsLimits: { claimsPerMinute: number; lanternRelightsPerDay: number; lanternReward: { material: string; qty: number } };
  outstandingInvites: number;
  migrationGiftCap: number;
  checkpointToleranceXp: number;
}
