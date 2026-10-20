/** Height lab (dev only): the areas the dev panel picks between. */
import { buildLabArea, type AreaName, type AreaOptions, type LabArea } from './area.ts'
import { buildMountain } from './mountain.ts'

export function buildArea(name: AreaName, opts: AreaOptions): LabArea {
  return name === 'mountain' ? buildMountain(opts) : buildLabArea(opts)
}
