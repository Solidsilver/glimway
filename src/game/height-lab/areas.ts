/** Height lab (dev only): the areas the dev panel picks between. */
import { buildLabArea, type AreaName, type AreaOptions, type LabArea } from './area.ts'
import { buildMountain } from './mountain.ts'
import { buildSlopes, type SlopesLook } from './slopes.ts'

export function buildArea(name: AreaName, opts: AreaOptions, slopes?: SlopesLook): LabArea {
  return name === 'mountain' ? buildMountain(opts) : name === 'slopes' ? buildSlopes(opts, slopes) : buildLabArea(opts)
}
