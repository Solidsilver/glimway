/**
 * Palettes for the Wilds' code-drawn art (./tangle-art.ts): the Tangle, and
 * the outer Wilds by the Mark their wick falls in. The outer drift is the
 * same woods made stranger: cooler shadows, paler wood, patches of white
 * quiet lying on the ground — and the leaves follow the year, so a new wick
 * reads as different land.
 *
 *  - Mudrise: wet and new; pale buds, dark mud, standing water.
 *  - Carting: the Green Hush; deep, warm summer leaf.
 *  - Amberfall: the sap tide; amber and russet crowns, litter everywhere.
 *  - Quiet: the White Quiet; frost on every crown, ice on the pools.
 */

type RGB = [number, number, number]

export interface Leaf {
  xd: string
  dk: string
  md: string
  lt: string
  hi: string
  gl: string
}

export interface Moss {
  dk: string
  md: string
  lt: string
  hi: string
}

export interface DecorPalette {
  oak: Leaf
  iron: Leaf
  pine: Leaf
  birch: Leaf
  shrub: Leaf
  moss: Moss
  /** Reed heads (bulrush brown, or frosted). */
  reedHead: string
}

export interface GroundPalette {
  woods: RGB[]
  moss: RGB[]
  path: RGB[]
  trodden: RGB[]
  road: RGB[]
  water: RGB[]
  litter: RGB[]
  mossFleck: RGB[]
  grassFleck: RGB[]
  jointMoss: RGB[]
  mortar: RGB
  pebble: RGB
  /** White quiet: pale drifts lying on the ground (outer only). */
  mist: RGB | null
  /** Litter drift density (higher = more fallen leaves). */
  litterAmount: number
}

export interface WildsLook {
  /** Atlas texture key for this look's decor. */
  atlas: string
  decor: DecorPalette
  ground: GroundPalette
}

function hex(col: string): RGB {
  const n = parseInt(col.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const ramp = (...cols: string[]): RGB[] => cols.map(hex)

// ------------------------------------------------------------ the Tangle

const TANGLE_DECOR: DecorPalette = {
  oak: { xd: '#1c3022', dk: '#284629', md: '#375f33', lt: '#4e7c3c', hi: '#73a04c', gl: '#9cc263' },
  iron: { xd: '#17231f', dk: '#22362c', md: '#2f4a38', lt: '#43634a', hi: '#627f52', gl: '#8a9a5a' },
  pine: { xd: '#132a27', dk: '#1b3c35', md: '#265244', lt: '#346a52', hi: '#4f8a62', gl: '#73aa74' },
  birch: { xd: '#2f4422', dk: '#41602c', md: '#587d36', lt: '#759b42', hi: '#9cbd58', gl: '#c4d978' },
  shrub: { xd: '#18291c', dk: '#223c25', md: '#30532e', lt: '#43703a', hi: '#5f8f48', gl: '#86b05c' },
  moss: { dk: '#3c5e2c', md: '#557f38', lt: '#74a046', hi: '#98c05a' },
  reedHead: '#6a4a2a'
}

const TANGLE_GROUND: GroundPalette = {
  woods: ramp('#141d14', '#1a2618', '#212f1d', '#283822', '#304228'),
  moss: ramp('#2b4626', '#33532b', '#3c6131', '#466f37', '#527d3d', '#5f8a43'),
  path: ramp('#4a3826', '#5a442e', '#6a5236', '#7a5f3e', '#896c46', '#987a50'),
  trodden: ramp('#433a26', '#52462d', '#605334', '#6e603b', '#7c6c42', '#8a7a4c'),
  road: ramp('#3e3e36', '#4c4b41', '#5b5a4d', '#6b695a', '#7b7866', '#8b8873'),
  water: ramp('#1c3440', '#22404c', '#2a4c58', '#345a66', '#4a7480', '#7aa2a8'),
  litter: ramp('#6a4426', '#7e5430', '#5a3a22'),
  mossFleck: ramp('#3a5a2c', '#4a7034'),
  grassFleck: ramp('#7aa24a', '#8cb456'),
  jointMoss: ramp('#3e6430', '#4f7a36'),
  mortar: hex('#3a3a30'),
  pebble: hex('#a89a86'),
  mist: null,
  litterAmount: 0.68
}

// ------------------------------------------------------------ the outer drift

/** Shared by every outer Mark: the deep drift's cooler floor and stones. */
const OUTER_BASE = {
  woods: ramp('#13181a', '#192123', '#1f2a29', '#26332f', '#2e3d36'),
  road: ramp('#3a3c3c', '#484a49', '#575957', '#676966', '#777975', '#888a84'),
  mortar: hex('#34363a'),
  pebble: hex('#b4b0a6'),
  mist: hex('#c8d2d6')
}

const OUTER: Record<string, { decor: DecorPalette; ground: GroundPalette }> = {
  Mudrise: {
    decor: {
      oak: { xd: '#1f3420', dk: '#2e502b', md: '#40703a', lt: '#5e9248', hi: '#88ba5c', gl: '#b4da7c' },
      iron: { xd: '#18261f', dk: '#24392d', md: '#33503b', lt: '#4a6c4a', hi: '#6e8e58', gl: '#98ac66' },
      pine: { xd: '#13292a', dk: '#1b3b38', md: '#265248', lt: '#356c56', hi: '#528c66', gl: '#7aae7a' },
      birch: { xd: '#3e5226', dk: '#587432', md: '#76963e', lt: '#9ab84e', hi: '#c0d86c', gl: '#e2f096' },
      shrub: { xd: '#1a2c1e', dk: '#264428', md: '#365e32', lt: '#4c7c3e', hi: '#6aa050', gl: '#94c46c' },
      moss: { dk: '#3e6a2c', md: '#58903a', lt: '#78b44a', hi: '#a0d468' },
      reedHead: '#5a3e24'
    },
    ground: {
      ...OUTER_BASE,
      moss: ramp('#29482a', '#30562f', '#386434', '#41723a', '#4c8040', '#588c46'),
      path: ramp('#30261e', '#3a2e24', '#45372a', '#504030', '#5b4a37', '#67553f'),
      trodden: ramp('#352c20', '#413626', '#4d402c', '#594a32', '#655438', '#715e3e'),
      water: ramp('#1a3038', '#203a44', '#284650', '#30525c', '#466c74', '#78a0a4'),
      litter: ramp('#4a3a24', '#5a462a', '#3e3020'),
      mossFleck: ramp('#3e6430', '#527e3a'),
      grassFleck: ramp('#8cc45a', '#a8d870'),
      jointMoss: ramp('#3e6a30', '#528438'),
      litterAmount: 0.8
    }
  },
  Carting: {
    decor: {
      oak: { xd: '#1a2e1c', dk: '#264626', md: '#346030', lt: '#4a7e3a', hi: '#6ea448', gl: '#a0c860' },
      iron: { xd: '#16221d', dk: '#20342a', md: '#2c4836', lt: '#406246', hi: '#5e7e50', gl: '#8c9c5a' },
      pine: { xd: '#122826', dk: '#1a3a33', md: '#245042', lt: '#326850', hi: '#4c8860', gl: '#70a872' },
      birch: { xd: '#2e4420', dk: '#40602a', md: '#567e34', lt: '#729c40', hi: '#98be54', gl: '#c6dc74' },
      shrub: { xd: '#17281b', dk: '#213c24', md: '#2e542d', lt: '#407038', hi: '#5c9046', gl: '#84b25a' },
      moss: { dk: '#3a5e2a', md: '#527e36', lt: '#70a044', hi: '#96c258' },
      reedHead: '#7a5430'
    },
    ground: {
      ...OUTER_BASE,
      moss: ramp('#2d4826', '#36562a', '#406430', '#4b7236', '#58803c', '#668e42'),
      path: ramp('#4a3a28', '#584530', '#665238', '#745e40', '#826a48', '#907852'),
      trodden: ramp('#443c28', '#52482e', '#605436', '#6e603c', '#7c6c44', '#8a7a4e'),
      water: ramp('#1c3640', '#22424c', '#2a4e58', '#345c66', '#4e7a84', '#86b0b4'),
      litter: ramp('#6a4a28', '#7e5832', '#5a3e24'),
      mossFleck: ramp('#3c5e2c', '#4c7434'),
      grassFleck: ramp('#a0b850', '#d8c870'),
      jointMoss: ramp('#3e6430', '#4f7a36'),
      litterAmount: 0.74
    }
  },
  Amberfall: {
    decor: {
      oak: { xd: '#3a1e14', dk: '#5e2e18', md: '#8a4420', lt: '#b8642a', hi: '#e0923c', gl: '#f4c060' },
      iron: { xd: '#2a1414', dk: '#441e1a', md: '#5e2a20', lt: '#7a3c28', hi: '#9a5a34', gl: '#c88a48' },
      pine: { xd: '#142624', dk: '#1c3832', md: '#284c40', lt: '#38644e', hi: '#56825c', gl: '#7c9e68' },
      birch: { xd: '#4a3a14', dk: '#7a5e1c', md: '#a8842a', lt: '#d0aa3c', hi: '#f0d060', gl: '#fff0a0' },
      shrub: { xd: '#2c1a14', dk: '#4a2618', md: '#6a3820', lt: '#8e5228', hi: '#b47038', gl: '#d89a50' },
      moss: { dk: '#5a5226', md: '#7a6e30', lt: '#9c8a3a', hi: '#c0aa4c' },
      reedHead: '#8a5a2a'
    },
    ground: {
      ...OUTER_BASE,
      moss: ramp('#3a3a1e', '#464624', '#52522a', '#5e5c30', '#6a6636', '#76703c'),
      path: ramp('#46321e', '#543c24', '#62482a', '#705430', '#7e6038', '#8c6c40'),
      trodden: ramp('#48341c', '#563e22', '#644a28', '#72562e', '#806234', '#8e6e3a'),
      water: ramp('#1e2c30', '#24363a', '#2c4244', '#364e50', '#506a6a', '#8a9e94'),
      litter: ramp('#b8642a', '#d08a3a', '#8a4420', '#e0a848'),
      mossFleck: ramp('#7a5a2a', '#a06a2a'),
      grassFleck: ramp('#c8a048', '#e0b858'),
      jointMoss: ramp('#5e5a2a', '#706a30'),
      litterAmount: 0.5
    }
  },
  Quiet: {
    decor: {
      oak: { xd: '#1c2a26', dk: '#283c34', md: '#365044', lt: '#4c6858', hi: '#a8c0c0', gl: '#eef6f6' },
      iron: { xd: '#161e1e', dk: '#20302c', md: '#2c403a', lt: '#3e5650', hi: '#90aaa8', gl: '#e4eeee' },
      pine: { xd: '#13242a', dk: '#1a3434', md: '#244640', lt: '#325a4e', hi: '#9ab8b4', gl: '#e8f4f4' },
      birch: { xd: '#4a4a56', dk: '#6a6a78', md: '#8a8a98', lt: '#aeb0bc', hi: '#d4d8e0', gl: '#f6f8fc' },
      shrub: { xd: '#1c2428', dk: '#283438', md: '#36464a', lt: '#4a5e60', hi: '#9ab0b2', gl: '#e2ecee' },
      moss: { dk: '#4a5e5a', md: '#62786e', lt: '#8aa29a', hi: '#c8dad4' },
      reedHead: '#c4c0b4'
    },
    ground: {
      ...OUTER_BASE,
      woods: ramp('#181c24', '#1e242c', '#252c34', '#2c343c', '#343e46'),
      moss: ramp('#5e6c76', '#6c7a84', '#7a8892', '#8a98a0', '#9aa8b0', '#acbac2'),
      path: ramp('#4a4440', '#57504a', '#645c54', '#71685e', '#7e7468', '#8b8072'),
      trodden: ramp('#4e4842', '#5a534c', '#665e56', '#726a60', '#7e766a', '#8a8274'),
      water: ramp('#6c8496', '#7890a2', '#849cae', '#94aabc', '#a6bcca', '#c6d8e2'),
      litter: ramp('#5a5450', '#6a625c', '#4a4440'),
      mossFleck: ramp('#c8d4da', '#e2eaee'),
      grassFleck: ramp('#dce6ea', '#f2f6f8'),
      jointMoss: ramp('#8a9aa2', '#a6b4ba'),
      litterAmount: 0.82
    }
  }
}

/** Atlas key for a look ('tangle', or the outer drift in a Mark). */
export function lookAtlasKey(style: 'tangle' | 'outer', mark: string | null | undefined): string {
  return style === 'outer' ? `wilds-decor-outer-${OUTER[mark ?? ''] ? mark : 'Carting'}` : 'tangle-decor'
}

/** The look for a style and Mark (an unknown Mark reads as Carting). */
export function wildsLook(style: 'tangle' | 'outer', mark: string | null | undefined): WildsLook {
  if (style !== 'outer') return { atlas: lookAtlasKey('tangle', null), decor: TANGLE_DECOR, ground: TANGLE_GROUND }
  const m = OUTER[mark ?? ''] ? (mark as string) : 'Carting'
  return { atlas: lookAtlasKey('outer', m), ...OUTER[m] }
}

/** The look an atlas key names (null when it isn't a Wilds decor atlas). */
export function lookForAtlas(key: string): WildsLook | null {
  if (key === 'tangle-decor') return wildsLook('tangle', null)
  const m = /^wilds-decor-outer-([A-Za-z]+)$/.exec(key)
  return m && OUTER[m[1]] ? wildsLook('outer', m[1]) : null
}
