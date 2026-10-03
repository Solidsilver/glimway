/**
 * Procedural, code-native pixel art.
 *
 * Every texture in the demo is generated here at boot from compact pixel-art
 * strings — no third-party assets, no network requests. Style target: small
 * chibi characters with big heads and dark outlines (Habitica-like), crisp
 * nearest-neighbor rendering, warm cozy terrain.
 */

type Palette = Record<string, string>
interface Art {
  rows: string[]
  pal: Palette
}

const OUTLINE = '#3a2a28'
const SKIN = '#f2c79c'
const SKIN_DARK = '#d9a678'

const WARM: Palette = {
  o: OUTLINE,
  S: SKIN,
  s: SKIN_DARK,
  e: '#4a3228',
  w: '#ffffff',
  P: '#7a5a3a',
  B: '#5c4128'
}

// ---------------------------------------------------------------- characters

const HERO_BODY: string[] = [
  '.....oooooo.....',
  '....oHHHHHHo....',
  '...oHHHHHHHHo...',
  '...oHSSSSSSHo...',
  '...oSeSSSSeSo...',
  '...oSSSSSSSSo...',
  '....oSSSSSSo....',
  '...ooTTTTTToo...',
  '..oTtTTTTTTtTo..',
  '..oStTTTTTTtSo..',
  '...oTTTTTTTTo...',
  '...oTTTtTTTTo...',
  '....oTTTTTTo....',
  '....oPPooPPo....',
  '....oBo..oBo....',
  '.....oo..oo.....'
]

const HERO_WALK: string[] = HERO_BODY.slice(0, 13).concat([
  '....oPPooPPo....',
  '...oBBo..oBBo...',
  '.....oo..oo.....'
])

const heroPal: Palette = {
  ...WARM,
  H: '#8a5a34',
  T: '#3f8f8b',
  t: '#5cb0a8'
}

const maraPal: Palette = {
  ...WARM,
  H: '#b25a3c',
  T: '#4a6f9c',
  t: '#6c93bd',
  A: '#f2e3b8'
}

// Mara wears a cream apron over her dress.
const MARA_BODY: string[] = HERO_BODY.slice(0, 9).concat([
  '..oStAAATAAASo..'.slice(0, 16),
  '...oTAAAAAAto...',
  '...oTAAAAAATo...',
  '....oAAAAAAo....',
  '....oPPooPPo....',
  '....oBo..oBo....',
  '.....oo..oo.....'
])

const orrinPal: Palette = {
  ...WARM,
  H: '#cfc6bb',
  T: '#8a6642',
  t: '#a3805a',
  A: '#e8e0d0'
}

// Orrin has a beard.
const ORRIN_BODY: string[] = HERO_BODY.slice(0, 5).concat([
  '...oSAeSSeASH...'.slice(0, 16),
  '...oSSSSSSSSo...',
  '...oAAAAAAAAo...',
  '...oAAAAAAAAo...'.slice(0, 16),
  '..oTAAAAAAAAto..'.slice(0, 16),
  '..oStAAAAAAtSo..'.slice(0, 16),
  '...oTTTTTTTTo...',
  '...oTTTtTTTTo...',
  '....oTTTTTTo....',
  '....oPPooPPo....',
  '....oBo..oBo....',
  '.....oo..oo.....'
])

const pipPal: Palette = {
  ...WARM,
  H: '#4a3228',
  T: '#d07090',
  t: '#e891ac'
}

// Pip is small: big head, short dress that flares.
const PIP_BODY: string[] = [
  '................',
  '.....oooooo.....',
  '....oHHHHHHo....',
  '...oHHHHHHHHo...',
  '...oHSSSSSSHo...',
  '...oSeSSSSeSo...',
  '...oSSSSSSSSo...',
  '....oSSSSSSo....',
  '...ooTTTTTToo...',
  '..oTtTTTTTTtTo..',
  '..oStTTTTTTtSo..',
  '...oTTTTTTTTo...',
  '..oTTTTTTTTTTo..',
  '..oTTtTTTTtTTo..',
  '....oSo..oSo....',
  '....oBo..oBo....'
]

// ---------------------------------------------------------------- creatures

const wispPal: Palette = {
  o: OUTLINE,
  W: '#9b6fd0',
  L: '#c09ae8',
  e: '#fff7d6',
  p: '#7c4fb0'
}

const WISP: string[] = [
  '.....oooooo.....',
  '...ooLLWWLLoo...',
  '..oLLWWWWWWLLo..',
  '.oLWWWeWWeWWWLo.',
  '.oLWWWeWWeWWWLo.',
  '.oWWWWWWWWWWWWo.',
  '.oWWpWWWWWWpWWo.',
  '.oWWWWWWWWWWWWo.',
  '..oWWWWWWWWWWo..',
  '..ooWWWWWWWWoo..',
  '....ooWWWWoo....',
  '......oWWo......',
  '.......oo.......',
  '................',
  '................',
  '................'
]

const guardianPal: Palette = {
  o: OUTLINE,
  D: '#3a3148',
  L: '#54496866'.slice(0, 7),
  e: '#7fe0e8',
  c: '#a8f0f4',
  E: '#241f31'
}

// Guardian shade: low quadruped silhouette with glowing eyes. 24x24.
const GUARDIAN_A: string[] = [
  '........................',
  '........................',
  '........................',
  '.....oo..........oo.....',
  '....oDDo........oDDo....',
  '....oDDDo......oDDDo....',
  '....oDDDDooooooDDDDo....',
  '...oDDDDDDDDDDDDDDDDo...',
  '..oDDDDDDDDDDDDDDDDDDo..',
  '..oDDeDDDDDDDDDDDDeDDo..',
  '.oDDceeDDDDDDDDDDceeDDo.',
  '.oDDDeeDDDDDDDDDDeeDDDo.',
  '.oDDDDDDDDDDDDDDDDDDDDo.',
  '.oDDDDDDDDDDDDDDDDDDDDo.',
  '.oDDDDDDoDDDDDDoDDDDDDo.',
  '.oDDDDDDDoDDDDoDDDDDDDo.',
  '..oDDDDDDDDDDDDDDDDDDo..',
  '..oDDoDDDDDDDDDDDDoDDo..',
  '..oDDo.DDo....oDD.oDDo..',
  '..oDDo..oo....oDDo.oDo..',
  '...oo.........oDDo......',
  '..............ooo.......',
  '........................',
  '........................'
]

const GUARDIAN_B: string[] = GUARDIAN_A.slice(0, 8).concat([
  '.oDDDDDDDDDDDDDDDDDDDDo.',
  'oDDDeDDDDDDDDDDDDDDeDDDo',
  'oDDceeDDDDDDDDDDDDceeDDo',
  'oDDDeeDDDDDDDDDDDDeeDDDo',
  'oDDDDDDDDDDDDDDDDDDDDDDo',
  'oDDDDDDDDDDDDDDDDDDDDDDo',
  '.oDDDDDDoDDDDDDoDDDDDDo.',
  '.oDDDDDDDoDDDDoDDDDDDDo.',
  '..oDDDDDDDDDDDDDDDDDDo..',
  '..oDDoDDDDDDDDDDDDoDDo..',
  '..oDDo.DDo....oDD.oDDo..',
  '..oDDo..oo....oDDo.oDo..',
  '...oo.........oDDo......',
  '..............ooo.......',
  '........................',
  '........................'
])

// ---------------------------------------------------------------- props

const treePal: Palette = {
  o: OUTLINE,
  C: '#4f7a3a',
  c: '#639a48',
  l: '#7fb35c',
  k: '#3c5e2e',
  W: '#6b4c2e'
}

const TREE: string[] = [
  '.....oooooo.....',
  '...ooccccccoo...',
  '..occllllllcco..',
  '.oclllcccclllco.',
  '.oclcccccccclco.',
  'occlcccccckccaco'.replace('a', 'c'),
  'occcccckkcccccaco'.slice(0, 16),
  'occlccckccccccco',
  '.oclcccccckccco.',
  '.occcclccccccko.',
  '..occcccckccco..',
  '..occlccccccco..',
  '...ooccckccoo...',
  '.....ooWWoo.....',
  '......oWWo......',
  '......oWWo......',
  '.....oWWWWo.....',
  '.....oooooo.....'
]

const bushPal: Palette = { o: OUTLINE, c: '#5f8f4c', l: '#7fb35c', k: '#3c5e2e' }
const BUSH: string[] = [
  '................',
  '................',
  '................',
  '................',
  '....oooooo......',
  '..ooclcccoo.....',
  '.oclcccccccoo...',
  'occcccckccccaco'.replace('a', 'c'),
  'occlcccccckccco.',
  '.occcckcccccko..',
  '..oocccccccoo...',
  '....ooooooo.....'
]

const rockPal: Palette = { o: OUTLINE, r: '#a49b8d', d: '#7e766a', k: '#5f584e' }
const ROCK: string[] = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '.....oooooo.....',
  '...oorrrrrdoo...',
  '..orrrrrrrrddo..',
  '.orrrrdddrrrrdo.',
  '.ordddrrrrrdddo.',
  '.ordddddddddddo.',
  '..oddddddddddo..',
  '...oooooooooo...',
  '................',
  '................'
]

const wellPal: Palette = { o: OUTLINE, r: '#a49b8d', d: '#7e766a', k: '#5f584e', W: '#6b4c2e', w: '#8a6642', R: '#c4654f', u: '#4d7ea8' }
const WELL: string[] = [
  '...oooooo....',
  '..oRRRRRRo...',
  '.oRRRRRRRRo..',
  '.oRoWWWWoRo..',
  '.oRo.oo.oRo..',
  '.oRowwwwoRo..',
  '.oRooooooRo..',
  '.oRRRRRRRRo..',
  '..orrrrrro...',
  '.orruuurruo..',
  '.oruuuuuuro..',
  '.oruuuuuuro..',
  '.orruuurruo..',
  '..orrrrrro...',
  '...oooooo....'
]

const muralPal: Palette = { o: OUTLINE, r: '#a49b8d', d: '#7e766a', k: '#5f584e', c: '#7fe0e8', C: '#4fa8b0' }
const MURAL: string[] = [
  '..oooooooooooo..',
  '.orrrrrrrrrrrdo.',
  '.orrcccrrrrrrdo.',
  '.orcCccrrddrrdo.',
  '.orcccrrcCcrrdo.',
  '.orrdddrrccrrdo.',
  '.orrcCcrrrrrrdo.',
  '.orrcccrrrrrrdo.',
  '.orrrrrrrrdddo..',
  '.orddddddddddo..',
  '..oooooooooooo..'
]

const lanternPal: Palette = {
  o: OUTLINE,
  W: '#6b4c2e',
  w: '#8a6642',
  G: '#5a5464',
  g: '#4a4452',
  F: '#ffd98a',
  f: '#ffefb8'
}

// Lantern post, unlit. 16x28.
const LANTERN_OFF: string[] = [
  '.....oooooo.....',
  '....oWWWWWWo....',
  '...oWwowwoWWo...',
  '...oWWWWWWWWo...',
  '...oWoggggoWo...',
  '...oWogGggoWo...',
  '...oWogGggoWo...',
  '...oWoggggoWo...',
  '...oWWWWWWWWo...',
  '...oWwowwoWWo...',
  '....oWWWWWWo....',
  '.....ooWWoo.....',
  '......oWWo......',
  '......oWWo......',
  '......oWWo......',
  '......oWWo......',
  '......oWWo......',
  '......oWWo......',
  '......oWWo......',
  '......oWWo......',
  '......oWWo......',
  '......oWWo......',
  '.....oWWWWo.....',
  '....oWWWWWWo....',
  '....oooooooo....',
  '................',
  '................',
  '................'
]

const LANTERN_ON: string[] = LANTERN_OFF.map((row, i) => {
  if (i >= 4 && i <= 8) {
    return row
      .replace(/g/g, 'F')
      .replace(/G/g, 'f')
  }
  return row
})

// ---------------------------------------------------------------- terrain (8x8, drawn at 2x)

const TILE_ART: Record<string, Art> = {
  grass_a: {
    rows: ['aaaaaaaa', 'aabaaaaa', 'aaaaacaa', 'aaaaaaaa', 'baaaaaaa', 'aaaaaaba', 'aacaaaaa', 'aaaaaaaa'],
    pal: { a: '#79a95f', b: '#628f4c', c: '#8fbe6f' }
  },
  grass_b: {
    rows: ['aacaaaaa', 'aaaaaaaa', 'baaaaaaa', 'aaaaaaba', 'aaaaaaaa', 'aabaaaaa', 'aaaaacaa', 'aaaaaaaa'],
    pal: { a: '#79a95f', b: '#628f4c', c: '#8fbe6f' }
  },
  grass_c: {
    rows: ['aaaaaaaa', 'acaaaaab', 'aaaaabaa', 'abaaaaaa', 'aaaacaaa', 'aaaaaaaa', 'caaaaaab', 'aaaabaaa'],
    pal: { a: '#79a95f', b: '#628f4c', c: '#8fbe6f' }
  },
  flowers: {
    rows: ['aaaaaaaa', 'awbaaacb', 'abaWaaaa', 'aaaaaacw', 'acaawaab', 'aaaaWaaa', 'aabaaaaa', 'aaacbaaa'],
    pal: { a: '#79a95f', b: '#628f4c', c: '#8fbe6f', w: '#fff3d6', W: '#e891ac' }
  },
  path_a: {
    rows: ['aaaaaaaa', 'aabaaaaa', 'caaaaaaa', 'aaaaaaba', 'aaaaaaaa', 'abaaaaac', 'aacaaaaa', 'aaaaaaaa'],
    pal: { a: '#d3a778', b: '#b98a5e', c: '#e0bb8c' }
  },
  path_b: {
    rows: ['acaabaaa', 'aaaaaaaa', 'aabaaaac', 'aaaaaaaa', 'caaaaaba', 'aaaaacaa', 'abaaaaaa', 'aaaacaaa'],
    pal: { a: '#d3a778', b: '#b98a5e', c: '#e0bb8c' }
  },
  dirt: {
    rows: ['aaaaaaaa', 'abaaaaab', 'aaaaacaa', 'baaaaaaa', 'aaaaaaba', 'aacaaaaa', 'aaaaabaa', 'aacaaaaa'],
    pal: { a: '#b08a5e', b: '#96724c', c: '#c4a074' }
  },
  sand: {
    rows: ['aabaaaaa', 'aaaaabaa', 'baaaaaaa', 'aaaacaaa', 'aaabaaaa', 'aaaaaaba', 'acaaaaaa', 'aaaabaab'],
    pal: { a: '#e2c996', b: '#cfae7a', c: '#efe0b4' }
  },
  water_a: {
    rows: ['aaaaaaaa', 'aacaaaaa', 'aaaaaaaa', 'caaaaaab', 'aaaacaaa', 'aaaaaaaa', 'abaaaaaa', 'aacaaaaa'],
    pal: { a: '#4f7fb8', b: '#3f6ba0', c: '#6f9fd4' }
  },
  water_b: {
    rows: ['aacaaaaa', 'aaaaaaaa', 'abaaaaac', 'aaaacaaa', 'aaaaaaaa', 'caaaaaab', 'aaaaacaa', 'aaaaaaaa'],
    pal: { a: '#4f7fb8', b: '#3f6ba0', c: '#6f9fd4' }
  },
  bridge: {
    rows: ['wwwwwwww', 'wWwwWwWw'.replace('W', 'w'), 'wwwwwwww', 'WwwWwwwW'.replace('W', 'w'), 'wwwwwwww', 'wWwwWwww'.replace('W', 'w'), 'wwwwwwww', 'wwwWwwWw'.replace('W', 'w')],
    pal: { w: '#a87e52' }
  },
  stone_a: {
    rows: ['aaaaaaaa', 'aaaaaaaa', 'bbbbabbb', 'aaaaaaaa', 'aaaaaaaa', 'bbbabbbb', 'aaaaaaaa', 'aaaaaaaa'],
    pal: { a: '#a89f92', b: '#8a8275' }
  },
  stone_b: {
    rows: ['aaaaaaaa', 'bbbaaaaa', 'aaaaaaaa', 'aaaabbbb', 'aaaaaaaa', 'aaaaaaaa', 'bbbbbaaa', 'aaaaaaaa'],
    pal: { a: '#a89f92', b: '#8a8275' }
  },
  stone_crack: {
    rows: ['aaaaaaaa', 'aaabaaaa', 'aabaaaaa', 'abaaaaaa', 'aaabaaaa', 'aaaabaaa', 'aaaaabaa', 'aaaaaaaa'],
    pal: { a: '#a89f92', b: '#6e675c' }
  },
  wall_stone: {
    rows: ['bbbabbba', 'aaaaaaaa', 'abbaaabb', 'aaaaaaaa', 'aaabbbaa', 'aaaaaaaa', 'bbaaaabb', 'aaaaaaaa'],
    pal: { a: '#6e675e', b: '#4f4840' }
  },
  wall_moss: {
    rows: ['bbbabbba', 'aacaaaaa', 'abbaaabb', 'aaaacaaa', 'aaabbbaa', 'aacaaaaa', 'bbaaaabb', 'aaacaaaa'],
    pal: { a: '#6e675e', b: '#4f4840', c: '#5f8f4c' }
  },
  roof: {
    rows: ['aaaaaaaa', 'bbbbbbbb', 'aaaaaaaa', 'bbbbbbbb', 'aaaaaaaa', 'bbbbbbbb', 'aaaaaaaa', 'bbbbbbbb'],
    pal: { a: '#c4654f', b: '#9c4c3a' }
  },
  roof_edge: {
    rows: ['cccccccc', 'aaaaaaaa', 'bbbbbbbb', 'aaaaaaaa', 'bbbbbbbb', 'aaaaaaaa', 'bbbbbbbb', 'aaaaaaaa'],
    pal: { a: '#c4654f', b: '#9c4c3a', c: '#d97e62' }
  },
  wall_house: {
    rows: ['aaaaaaaa', 'aaaaaaaa', 'bbaaaaab'.replace('b', 'a'), 'aaaaaaaa', 'aaaaaaaa', 'aaaaaaaa', 'aaaaaaaa', 'aaaaaaaa'],
    pal: { a: '#eadcb2', b: '#d8c79c' }
  },
  door: {
    rows: ['wwwwwwww', 'wWWWWWWw'.replace('W', 'w'), 'wWwwwwWw'.replace('W', 'w'), 'wwwwwwww', 'wwwwwwww', 'wwwwwwww', 'wFwwwwww'.replace('F', 'w'), 'wwwwwwww'],
    pal: { w: '#7a5a3a' }
  },
  window: {
    rows: ['wwwwwwww', 'wffffffw', 'wfFFFFfw'.slice(0, 8), 'wfFFFFfw', 'wffffffw', 'wwwwwwww', 'wwwwwwww', 'wwwwwwww'],
    pal: { w: '#7a5a3a', f: '#5a5464', F: '#ffd98a' }
  },
  fence: {
    rows: ['aaaaaaaa', 'wwwwwwww', 'aaaaaaaa', 'ww.w.www', 'aaaaaaaa', 'ww.w.www', 'aaaaaaaa', 'aaaaaaaa'],
    pal: { a: ' ', w: '#8a6642' }
  }
}

// ---------------------------------------------------------------- helpers

function paintArt(ctx: CanvasRenderingContext2D, art: Art, ox: number, oy: number, scale = 1): void {
  for (let y = 0; y < art.rows.length; y++) {
    const row = art.rows[y]
    for (let x = 0; x < row.length; x++) {
      const color = art.pal[row[x]]
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale)
    }
  }
}

/**
 * Registers a generated canvas texture. If a texture with the same key was
 * already loaded in BootScene.preload (the drop-in path for real art later),
 * the generated placeholder is skipped and the loaded file wins.
 */
function addCanvasTexture(
  scene: Phaser.Scene,
  key: string,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void
): void {
  if (scene.textures.exists(key)) return
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  draw(ctx)
  scene.textures.addCanvas(key, canvas)
}

function artSize(art: Art): { w: number; h: number } {
  return { w: Math.max(...art.rows.map((r) => r.length)), h: art.rows.length }
}

function addArtTexture(scene: Phaser.Scene, key: string, art: Art): void {
  const { w, h } = artSize(art)
  addCanvasTexture(scene, key, w, h, (ctx) => paintArt(ctx, art, 0, 0))
}

// ---------------------------------------------------------------- public API

export const TILE = 16

/** Tile ids used by the world builder; values are columns in the terrain sheet. */
export const TERRAIN = {
  grass_a: 0,
  grass_b: 1,
  grass_c: 2,
  flowers: 3,
  path_a: 4,
  path_b: 5,
  dirt: 6,
  sand: 7,
  water_a: 8,
  water_b: 9,
  bridge: 10,
  stone_a: 11,
  stone_b: 12,
  stone_crack: 13,
  wall_stone: 14,
  wall_moss: 15,
  roof: 16,
  roof_edge: 17,
  wall_house: 18,
  door: 19,
  window: 20,
  fence: 21
} as const

export function generateTextures(scene: Phaser.Scene): void {
  // --- terrain sheet: 7 columns x 3 rows of 16px tiles (8x8 art at 2x)
  const keys = Object.keys(TERRAIN) as (keyof typeof TERRAIN)[]
  const cols = 7
  const rows = Math.ceil(keys.length / cols)
  addCanvasTexture(scene, 'terrain', cols * TILE, rows * TILE, (ctx) => {
    keys.forEach((k, i) => {
      const cx = (i % cols) * TILE
      const cy = Math.floor(i / cols) * TILE
      paintArt(ctx, TILE_ART[k], cx, cy, 2)
    })
  })

  // --- characters
  addArtTexture(scene, 'hero0', { rows: HERO_BODY, pal: heroPal })
  addArtTexture(scene, 'hero1', { rows: HERO_WALK, pal: heroPal })
  addArtTexture(scene, 'mara', { rows: MARA_BODY, pal: maraPal })
  addArtTexture(scene, 'orrin', { rows: ORRIN_BODY, pal: orrinPal })
  addArtTexture(scene, 'pip', { rows: PIP_BODY, pal: pipPal })
  addArtTexture(scene, 'wisp', { rows: WISP, pal: wispPal })
  addArtTexture(scene, 'guardian0', { rows: GUARDIAN_A, pal: guardianPal })
  addArtTexture(scene, 'guardian1', { rows: GUARDIAN_B, pal: guardianPal })

  // --- props
  addArtTexture(scene, 'tree', { rows: TREE, pal: treePal })
  addArtTexture(scene, 'bush', { rows: BUSH, pal: bushPal })
  addArtTexture(scene, 'rock', { rows: ROCK, pal: rockPal })
  addArtTexture(scene, 'well', { rows: WELL, pal: wellPal })
  addArtTexture(scene, 'mural', { rows: MURAL, pal: muralPal })
  addArtTexture(scene, 'lantern_off', { rows: LANTERN_OFF, pal: lanternPal })
  addArtTexture(scene, 'lantern_on', { rows: LANTERN_ON, pal: lanternPal })

  // --- effects
  addCanvasTexture(scene, 'slash', 18, 18, (ctx) => {
    ctx.fillStyle = '#fff7d6'
    const arc: Array<[number, number]> = [
      [13, 3], [14, 4], [15, 5], [15, 6], [16, 7], [16, 8],
      [12, 4], [13, 5], [14, 6], [14, 7], [15, 8],
      [11, 5], [12, 6], [13, 7], [13, 8], [14, 9],
      [11, 7], [11, 8], [12, 9], [12, 10]
    ]
    for (const [x, y] of arc) ctx.fillRect(x, y, 2, 2)
    ctx.fillStyle = 'rgba(255,247,214,0.55)'
    for (const [x, y] of arc) ctx.fillRect(x + 2, y + 2, 1, 1)
  })

  addCanvasTexture(scene, 'bolt', 8, 8, (ctx) => {
    ctx.fillStyle = '#4fa8b0'
    ctx.fillRect(0, 2, 8, 4)
    ctx.fillStyle = '#7fe0e8'
    ctx.fillRect(1, 2, 6, 3)
    ctx.fillStyle = '#fff7d6'
    ctx.fillRect(2, 3, 4, 2)
  })

  addCanvasTexture(scene, 'spark', 4, 4, (ctx) => {
    ctx.fillStyle = '#fff7d6'
    ctx.fillRect(1, 0, 2, 4)
    ctx.fillRect(0, 1, 4, 2)
  })

  addCanvasTexture(scene, 'shadow', 14, 7, (ctx) => {
    ctx.fillStyle = 'rgba(30,20,25,0.35)'
    ctx.beginPath()
    ctx.ellipse(7, 3.5, 6.5, 3, 0, 0, Math.PI * 2)
    ctx.fill()
  })

  addCanvasTexture(scene, 'glow', 64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,224,150,0.85)')
    g.addColorStop(0.35, 'rgba(255,205,120,0.45)')
    g.addColorStop(1, 'rgba(255,190,100,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
  })

  addCanvasTexture(scene, 'px', 2, 2, (ctx) => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 2, 2)
  })
}
