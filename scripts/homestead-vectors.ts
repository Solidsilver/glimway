/**
 * Writes content/vectors/homestead.json: lantern post prices, which the Go
 * rules (content.HomeRules.PostCost) must match. (Homestead land is the
 * server's alone; server/internal/land keeps its own goldens.)
 *
 * Run: npm run vectors:homestead
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { postCost } from '../src/lib/homestead-land.ts';

export function homesteadVectors() {
  const posts = Array.from({ length: 7 }, (_, n) => ({ n, cost: postCost(n) }));
  return { posts };
}

export function serializeHomesteadVectors(): string {
  return `${JSON.stringify(homesteadVectors())}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  writeFileSync(new URL('../content/vectors/homestead.json', import.meta.url), serializeHomesteadVectors());
}
