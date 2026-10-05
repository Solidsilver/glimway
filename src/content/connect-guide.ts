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
// Full notes and file links: .agent/app-paths.md. The Habitica wiki ("API
// Options") is outdated on all three platforms; don't copy steps from it.
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
  unsafeNothing: 'Syncing only works in Hearthwick or the Commons. Nothing changed.',
  sampleUnsafe: 'Sample heroes follow the same rules: head back to Hearthwick or the Commons first.'
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
    'Stored in this browser, apart from your save and never in a save code. Anything that can run script on this site could read it, and your token can write to your Habitica account. Leave this off to paste again each visit.',
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
      'Your name, class, level, health, mana, experience, stats, equipped gear, pet and mount, and how your avatar looks.'
    ]
  },
  never: {
    title: 'What it never does',
    items: [
      'Score or create tasks, spend gold, change stats, equip or buy anything, cast spells, or touch your party.',
      'Send your token anywhere except Habitica itself.'
    ]
  },
  honest:
    'The honest part: Habitica API tokens aren’t read-only. A token can change your account. The game limits itself to reading, and its code is public so you can check, but the token itself has no such limit.',
  where:
    'Where it goes: into this tab’s memory, and nowhere else. It is never put in your save, a save code, or a log. Only if you tick Remember on this device is it also stored in this browser, apart from your save.'
}

/** Ember payoff line (shown under the title choice and in the connected step). */
export function emberLine(xpPerEmber: number): string {
  return `From now on, every ${xpPerEmber} XP you earn in Habitica becomes an ember that lights the road.`
}

export const titleChoice = {
  habitica: 'Play as your Habitica hero',
  guest: 'Wander as a guest',
  guestMeta: 'The demo hero. No account, no network. You can connect later in the Menu.'
}

/** Pip's one-off line for a guest at the Hearthwick gate. */
export const pipGateNudge =
  'Pip calls from the square: “Going out there as a guest? Open the Menu and connect your Habitica hero. Every bit of real-life XP becomes embers for the road!”'
