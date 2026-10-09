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

// ---------------------------------------------------------------- terrain (8x8, drawn at 2x)

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

// ---------------------------------------------------------------- world UI markers

const markPal: Palette = {
  o: '#2b1d1a',
  y: '#ffd24a',
  h: '#fff3c4',
  Y: '#d99a1e',
  k: '#4a3220',
  w: '#fffbef',
  g: '#d8c79c',
  p: '#f4e4c1',
  s: '#b89a6a'
}

/** Gold "!" bubble: this character moves the story forward. */
const MARK_QUEST: string[] = [
  '.ooooooo.',
  'ohhyyyyyo',
  'ohyykyyYo',
  'oyyykyyYo',
  'oyyykyyYo',
  'oyyykyyYo',
  'oyyyyyyYo',
  'oyyykyyYo',
  'oYYYYYYYo',
  '.ooooooo.',
  '...oYo...',
  '....o....'
]

/** Speech bubble "…": someone with something new to say. */
const MARK_TALK: string[] = [
  '.ooooooooo.',
  'owwwwwwwwgo',
  'owwwwwwwwgo',
  'owkwwkwwkgo',
  'owwwwwwwwgo',
  'ogggggggggo',
  '.oooggoooo.',
  '...ogo.....',
  '...oo......'
]

/** Exit chevron (points right; rotated per exit side). */
const MARK_CHEVRON: string[] = [
  'oo.....',
  'oyo....',
  'ohyo...',
  '.ohyo..',
  '..oyyo.',
  '.oyyo..',
  'oyyo...',
  'oyo....',
  'oo.....'
]

const GLYPH_E = ['kkkk', 'k...', 'kkk.', 'k...', 'kkkk']

/**
 * The touch hint: a small gold coin with a four-point sparkle, the same face
 * as the phone's action button (a keycap letter would name a key a phone
 * doesn't have).
 */
const KEY_TAP = [
  '...ooooo...',
  '..oyyyyyo..',
  '.oyyyhyyyo.',
  'oyyyyhyyyyo',
  'oyyykhkyyyo',
  'oyhhhkhhhyo',
  'oyyykhkyyyo',
  'oyyyyhyyyyo',
  '.oYyyhyyYo.',
  '..oYYYYYo..',
  '...ooooo...'
]

/** A small parchment keycap with a 4x5 glyph and a pressed-edge shadow. */
function keycap(glyph: string[]): string[] {
  // 11 wide: outline, 3px margin, 4px glyph, 2px margin, outline.
  const rows = ['.ooooooooo.', 'owwwwwwwwwo']
  for (const g of glyph) rows.push('owpp' + g.replace(/\./g, 'p') + 'ppo')
  rows.push('opppppppppo', 'ossssssssso', '.ooooooooo.')
  return rows
}

function artSize(art: Art): { w: number; h: number } {
  return { w: Math.max(...art.rows.map((r) => r.length)), h: art.rows.length }
}

function addArtTexture(scene: Phaser.Scene, key: string, art: Art): void {
  const { w, h } = artSize(art)
  addCanvasTexture(scene, key, w, h, (ctx) => paintArt(ctx, art, 0, 0))
}

// ---------------------------------------------------------------- public API


export function generateTextures(scene: Phaser.Scene): void {
  // --- characters
  addArtTexture(scene, 'hero0', { rows: HERO_BODY, pal: heroPal })
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

  // The signpost's lost east finger (the opening): a pointed board lying in the bracken.
  addCanvasTexture(scene, 'signpost-finger', 16, 7, (ctx) => {
    ctx.fillStyle = '#2b1d1a'
    ctx.beginPath()
    ctx.moveTo(0, 1)
    ctx.lineTo(12, 1)
    ctx.lineTo(16, 3.5)
    ctx.lineTo(12, 6)
    ctx.lineTo(0, 6)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#a8763e'
    ctx.beginPath()
    ctx.moveTo(1, 2)
    ctx.lineTo(12, 2)
    ctx.lineTo(14.5, 3.5)
    ctx.lineTo(12, 5)
    ctx.lineTo(1, 5)
    ctx.closePath()
    ctx.fill()
    // The grain, and the old paint of its letters.
    ctx.fillStyle = '#8a5a32'
    ctx.fillRect(1, 4, 11, 1)
    ctx.fillStyle = '#e8d4a4'
    ctx.fillRect(3, 3, 1, 1)
    ctx.fillRect(5, 3, 2, 1)
    ctx.fillRect(8, 3, 1, 1)
  })

  addCanvasTexture(scene, 'glow', 64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,224,150,0.85)')
    g.addColorStop(0.35, 'rgba(255,205,120,0.45)')
    g.addColorStop(1, 'rgba(255,190,100,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
  })

  // --- world UI markers (crisp pixel art, drawn above everything)
  addArtTexture(scene, 'mark-quest', { rows: MARK_QUEST, pal: markPal })
  addArtTexture(scene, 'mark-talk', { rows: MARK_TALK, pal: markPal })
  addArtTexture(scene, 'mark-chevron', { rows: MARK_CHEVRON, pal: markPal })
  addArtTexture(scene, 'key-e', { rows: keycap(GLYPH_E), pal: markPal })
  addArtTexture(scene, 'key-tap', { rows: KEY_TAP, pal: markPal })

  addCanvasTexture(scene, 'px', 2, 2, (ctx) => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 2, 2)
  })
}
