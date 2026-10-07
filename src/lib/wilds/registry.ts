/**
 * Registry of generator modules by version. A region's epoch freezes its
 * generator version; new versions are added as new modules (gen-v2.ts, …)
 * and registered here — v1 is never touched once live epochs use it.
 */
import { genV1 } from './gen-v1.ts';
import type { WildsGenerator } from './types.ts';

const GENERATORS: Record<number, WildsGenerator> = {
  1: genV1,
};

export function generatorFor(version: number): WildsGenerator {
  const gen = GENERATORS[version];
  if (!gen) throw new Error(`wilds: unknown generator version ${version}`);
  return gen;
}
