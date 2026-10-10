/**
 * All copy for the Habitica connect guide. Components render this verbatim, so
 * wording and steps can change without touching them.
 */

export type GuideTabId = 'website' | 'ios' | 'android'

export interface GuideTab {
  id: GuideTabId
  label: string
  /** Set while the steps have not been checked against the real app. The UI
   * shows `unverifiedNote` next to the steps. */
  unverified: boolean
  steps: string[]
  /** Short line shown under the steps. */
  note?: string
}

// Source: the open-source clients' current default branches (habitica @
// develop, habitica-ios @ develop, habitica-android @ main), read 2026-10-04.
// The Habitica wiki ("API Options") is outdated on all three platforms; don't
// copy steps from it.
export const guideTabs: GuideTab[] = [
  {
    id: 'website',
    label: 'Website',
    unverified: false,
    steps: [
      'Sign in at habitica.com and open the avatar menu (top right).',
      'Choose Settings, then the Site Data tab.',
      'Your User ID is shown on the User ID row. Press Copy.',
      'The API Token is hidden at first. On the API Token row, click Learn More, then press Copy.'
    ]
  },
  {
    id: 'ios',
    label: 'iOS app',
    unverified: false,
    steps: [
      'Open the Habitica app, tap your avatar (top left), and choose Settings from the menu.',
      'Tap My Account, then find the User Data section.',
      'Tap User ID to copy it.',
      'Tap API Token, then press Copy Token in the sheet that opens.'
    ],
    note: 'Older app versions may differ.'
  },
  {
    id: 'android',
    label: 'Android app',
    unverified: false,
    steps: [
      'Open the Habitica app, open the side drawer, and tap the gear icon (Settings).',
      'Tap My Account, then find the User Data section.',
      'Tap User ID to copy it.',
      'Tap API Token, then press Copy Token in the sheet that opens.'
    ],
    note: 'Older app versions may differ.'
  }
]

/** Shown above the steps of any tab flagged `unverified: true`. */
export const unverifiedNote = 'These steps may differ in your app version. If you can’t find them, use the website.'

/** Where syncing can happen (Hearthwick or the Commons, src/lib/habitica/sync.ts SAFE_AREAS). */
export const syncCopy = {
  goSafe: 'Head back to Hearthwick or the Commons first — syncing only happens somewhere safe.',
  midSync: 'Something happened mid-sync. Try again from a quiet spot in Hearthwick or the Commons.',
  unsafeUnchanged: 'Syncing only works in Hearthwick or the Commons. Your save is unchanged.',
  unsafeNothing: 'Syncing only works in Hearthwick or the Commons. Nothing changed.'
}

export const guideCopy = {
  title: 'Play as your Habitica hero',
  step1: 'Find your User ID and API Token',
  step1Intro: 'Tools like this one need two values from Habitica: your User ID, and your API Token (that one is a secret, so treat it like a password). You need both.',
  step2: 'Paste them here',
  step2Intro:
    'Paste both together (labels like “User ID:” and “API Token:” are fine), or fill the two boxes below.',
  pasteLabel: 'Paste both values',
  pasteHint: 'Both are long codes of letters and digits. Nothing is sent until you press Connect.',
  userIdLabel: 'User ID',
  tokenLabel: 'API Token',
  previewTitle: 'Is this the right way round?',
  previewBody: 'Two unlabeled codes were pasted. We guessed the first is your User ID. Swap them if that’s wrong.',
  swapSuggestion:
    'Habitica didn’t recognise those. If you pasted two unlabeled codes, they may be the wrong way round. Try Swap, then Connect again.',
  step3: 'Connected',
  rememberLabel: 'Remember on this device',
  rememberExposure:
    'Stored in this browser, apart from your journey. Anything that can run script on this site could read it, and your token can write to your Habitica account. Leave this off to paste again each visit.',
  rememberOffNote: 'Your details stay in this tab’s memory only. Closing the tab forgets them.',
  forgetLabel: 'Forget',
  forgottenToast: 'Forgotten. Nothing is stored on this device.',
  rememberFailed: 'This browser wouldn’t store them, so they’ll be forgotten when the tab closes.',
  disconnectAsk: {
    title: 'Forget your details too?',
    body: 'They’re remembered on this device. Forget them, or keep them so you can reconnect without pasting.',
    forget: 'Disconnect and forget',
    keep: 'Disconnect, keep remembered'
  }
}

export interface WhyToken {
  summary: string
  reads: { title: string; items: string[] }
  writes: { title: string; items: string[] }
  never: { title: string; items: string[] }
  honest: string
  where: string
}

export const whyToken: WhyToken = {
  summary: 'Why does it need my token?',
  reads: {
    title: 'What it reads',
    items: [
      'One request to your Habitica profile, each time you press Sync, and when you connect.',
      'Your name, class, level, health, mana, experience, gold, stats, equipped gear, pet and mount, and how your avatar looks.'
    ]
  },
  writes: {
    title: 'What it writes, and only when you ask',
    items: [
      'When you press Turn gold into glims in the Menu and agree on the card, the world server turns the gold you chose into glims, two gold for each glim, at most 30 glims a day: it adds a reward called “Glimway purse” to your Habitica Rewards, buys it once, and removes it. Your Habitica gold goes down by that amount. Nothing else on Habitica changes, and glims never turn back into gold.'
    ]
  },
  never: {
    title: 'What it never does',
    items: [
      'Score your own tasks, change stats, equip anything, buy any of your own rewards, cast spells, or touch your party. Gold leaves Habitica only in a top-up you agreed to, and turns into glims.',
      'Keep your token. Glimway’s server sees it at sign-in to prove your account, and in a top-up or a gear check you start, for that one request. It never stores, logs or returns it.'
    ]
  },
  honest:
    'The honest part: Habitica API tokens aren’t read-only. A token can change your account. The game reads, and writes only to spend the gold you chose when you turn it into glims. Its code is public so you can check, but the token itself has no such limit.',
  where:
    'Where it goes: to Habitica, to read your profile; to your Glimway server at sign-in, to prove your account; and to the server again only in a top-up or a gear check you start, for that one request. The server never stores it, and it is never put in your journey or a log. Only if you tick Remember on this device is it also stored in this browser, apart from your journey.'
}

/** Glim payoff line (shown under the title choice and in the connected step). */
export function glimLine(xpPerGlim: number): string {
  return `From now on, every ${xpPerGlim} XP you earn in Habitica becomes a glim: a bead of amber that holds a little light.`
}

/** What a sync's glims say (silas-yard.md 1.2, 1.8): the toast, and Mara's welcome. */
export const syncGlimsCopy = {
  gained: (n: number, xp?: number) => `${n === 1 ? '1 glim' : `${n} glims`} caught the light.${xp ? ` That’s the ${xp} XP you earned on Habitica.` : ''}`,
  welcome: (n: number) => `Mara presses ${n === 1 ? 'a glim' : `${n} glims`} into your hand. “For the lanterns. Earn more out there.”`,
  holding: (n: number) => `Mara is holding ${n === 1 ? 'a glim' : `${n} glims`} for you to start.`
}

export const titleChoice = {
  habitica: 'Play as your Habitica hero'
}

/** The title, when the world server didn't answer. */
export const unreachableCopy = {
  title: 'Can’t reach the world',
  body: 'Glimway plays in your browser, but your journey lives on its world server — and it didn’t answer. Check your connection, then try again.',
  retry: 'Try again'
}

/** The Menu's About card (purse-and-wardrobe.md 6.6). */
export const aboutCopy = {
  kept: 'Glimway plays in your browser. Your journey is kept in your world on the Glimway server; your Habitica token never is.',
  gold: 'Habitica gold turns into glims only when you ask, two gold for each, at most 30 glims a day. Glims never turn back into gold.'
}
