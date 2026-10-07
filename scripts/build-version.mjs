/**
 * The web build's version and build id (vite.config.ts loads this plugin).
 *
 * The version is package.json's: the one source every build reads (the Nix
 * packages read it too). The build id says which build this is, so a tab
 * can tell when a newer one is being served (src/lib/version.ts):
 *
 * 1. GLIMWAY_BUILD, when the build is handed one (the Dockerfile's build
 *    argument, which the release workflow fills from the commit; the flake's
 *    clean revision). A full commit hash is shortened.
 * 2. The short git commit, when the tree is a clean checkout.
 * 3. Otherwise a hash of the build's inputs (no .git in the Nix sandbox or a
 *    Docker context, or uncommitted changes the commit wouldn't describe).
 *
 * `vite build` defines __GLIMWAY_VERSION__ and __GLIMWAY_BUILD__ for the
 * client and writes dist/version.json ({ "version", "build" }). The dev
 * server's build is "dev" and it serves no version.json.
 *
 * Plain JavaScript so vite.config.ts can load it without Node types.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/** What the content hash covers: everything `vite build` reads. */
const INPUTS = ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'svelte.config.js', 'tsconfig.json', 'scripts/build-version.mjs', 'src', 'public', 'content']

const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** @param {string} root */
export function readVersion(root) {
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json version ${JSON.stringify(version)} is not x.y.z`)
  return version
}

/** @param {string | undefined} given */
function fromEnv(given) {
  const id = (given ?? '').trim()
  if (!BUILD_ID.test(id)) return null
  return /^[0-9a-f]{40}$/.test(id) ? id.slice(0, 7) : id
}

/** @param {string} root @param {string[]} args */
function git(root, args) {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim()
}

/** The short commit of a clean checkout, else null. @param {string} root */
function fromGit(root) {
  try {
    if (git(root, ['status', '--porcelain', '--', ...INPUTS]) !== '') return null
    return git(root, ['rev-parse', '--short=7', 'HEAD']) || null
  } catch {
    return null
  }
}

/** Twelve hex digits over every input file's path and bytes. @param {string} root */
export function contentHash(root) {
  /** @type {string[]} */
  const files = []
  /** @param {string} rel */
  const walk = (rel) => {
    const abs = path.join(root, rel)
    let info
    try {
      info = statSync(abs)
    } catch {
      return
    }
    if (info.isDirectory()) {
      for (const name of readdirSync(abs).sort()) if (!name.startsWith('.')) walk(`${rel}/${name}`)
    } else if (info.isFile()) {
      files.push(rel)
    }
  }
  for (const input of INPUTS) walk(input)
  const hash = createHash('sha256')
  for (const rel of files.sort()) {
    hash.update(`${rel}\0`)
    hash.update(readFileSync(path.join(root, rel)))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

/** @param {string} root @param {Record<string, string | undefined>} env */
export function buildInfo(root, env = process.env) {
  return { version: readVersion(root), build: fromEnv(env.GLIMWAY_BUILD) ?? fromGit(root) ?? contentHash(root) }
}

/** @returns {import('vite').Plugin} */
export default function versionPlugin() {
  /** @type {{ version: string, build: string }} */
  let info
  return {
    name: 'glimway-version',
    config(config, { command }) {
      const root = path.resolve(config.root ?? process.cwd())
      info = command === 'build' ? buildInfo(root) : { version: readVersion(root), build: 'dev' }
      return { define: { __GLIMWAY_VERSION__: JSON.stringify(info.version), __GLIMWAY_BUILD__: JSON.stringify(info.build) } }
    },
    configResolved(config) {
      if (config.command === 'build') config.logger.info(`Glimway ${info.version} (build ${info.build})`)
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify(info)}\n` })
    }
  }
}
