/**
 * Swapping a freshly baked atlas folder into place (scripts/build-atlases.ts).
 *
 * The staging and backup folders sit beside the destination, so every rename
 * stays on one filesystem, and carry a per-run tag, so two builds never share
 * them. The install is two renames: the current folder aside, then the new
 * one in. If the second fails, the old folder goes back, so the destination
 * is never left missing. The backup is deleted only once the new folder is in.
 */
import { renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export interface InstallDirs {
  /** Where the bake writes. */
  staged: string
  /** Where the current folder waits while the new one goes in. */
  backup: string
}

/** Unique staging and backup folders beside `dest` (dot-named: never part of the shipped set). */
export function installDirs(dest: string, tag = `${process.pid}-${Date.now().toString(36)}`): InstallDirs {
  const at = (what: string) => join(dirname(dest), `.${basename(dest)}-${what}-${tag}`)
  return { staged: at('staging'), backup: at('old') }
}

/** Put `dirs.staged` at `dest`. `rename` is injectable so a test can make a step fail. */
export function installStaged(dest: string, dirs: InstallDirs, rename: (from: string, to: string) => void = renameSync): void {
  let aside = false
  try {
    rename(dest, dirs.backup)
    aside = true
  } catch (err) {
    // A first build has nothing to set aside.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  try {
    rename(dirs.staged, dest)
  } catch (err) {
    if (aside) rename(dirs.backup, dest)
    throw err
  }
  if (aside) rmSync(dirs.backup, { recursive: true, force: true })
}
