/**
 * `virtual:whats-new`: the released versions' "For players" lines from
 * CHANGELOG.md, parsed when the game is built (vite.config.ts loads this
 * plugin), for the "What's new" card (src/ui/WhatsNew.svelte). The parser is
 * src/lib/changelog.ts, which Node runs as TypeScript.
 *
 * Plain JavaScript so vite.config.ts can load it without Node types.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseChangelog } from '../src/lib/changelog.ts'

const ID = 'virtual:whats-new'
const RESOLVED = '\0' + ID

/** @returns {import('vite').Plugin} */
export default function whatsNew() {
  let root = process.cwd()
  return {
    name: 'glimway-whats-new',
    configResolved(config) {
      root = config.root
    },
    resolveId(id) {
      return id === ID ? RESOLVED : null
    },
    load(id) {
      if (id !== RESOLVED) return null
      const file = path.join(root, 'CHANGELOG.md')
      this.addWatchFile(file)
      const released = parseChangelog(readFileSync(file, 'utf8')).filter((r) => r.version !== 'Unreleased' && r.players.length > 0)
      return `export default ${JSON.stringify(released)}`
    }
  }
}
