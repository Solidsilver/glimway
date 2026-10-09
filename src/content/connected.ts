/**
 * Copy for connected play: signing in to a Glimway world, the play lease,
 * offline play, and invites. Plain and short.
 */
import { ECONOMY as economy } from '../lib/economy.ts'
export const INVITE_LIMIT = economy.outstandingInvites
export const INVITE_LIFETIME = economy.lifetimeInvites

export const signInCopy = {
  inviteToggle: 'Have an invite code?',
  inviteLabel: 'Invite code',
  invitePlaceholder: 'e.g. amber-fox-river-lantern-moss-ivy-7392',
  inviteHint: 'Any case; spaces or hyphens are fine.',
  /** Read before anything about codes: a party member needs none. */
  partyWelcome: 'Already in a Habitica party that plays here? Connect and come straight in. No invite code needed.',
  inviteOnlyTitle: 'This world is invite-only',
  inviteOnlyBody: 'Your Habitica hero is fine. To come in you need an invite code, or a party that already plays here.',
  inviteJoin: 'Join with this code',
  signedIn: (name: string) => `Signed in to your world as ${name}.`,
  rateLimited: (s: number) => `Too many sign-ins just now. Try again in about ${s} seconds.`,
  serverTrouble: 'The world server had a problem. Try again in a moment.',
  /** The sign-in couldn't reach the world at all (an unreachable server). */
  unreachable: 'Can’t reach the world. Check your connection, then try again.'
}

export const leaseCopy = {
  title: 'Playing on another device',
  body: 'Your journey is open somewhere else. Only one place can play at a time.',
  note: 'Taking over pauses the other device. Its latest progress is kept.',
  takeOver: 'Take over here',
  back: 'Not now',
  toTitle: 'Back to the title',
  working: 'Taking over…',
  failed: 'Couldn’t take over just now. Try again in a moment.',
  signedOutTitle: 'You’ve been signed out',
  signedOutBody: 'Your progress so far is saved in your world. Sign in again from the title to keep playing there.'
}

export const offlineCopy = {
  chip: 'Offline',
  chipTitle: 'Saving on this device. Spends and syncs need a connection.',
  troubleChip: 'Server trouble',
  troubleTitle: 'The world server is having trouble. Saving on this device; spends and syncs wait.',
  needs: 'Needs a connection',
  pending: 'Asking the world…',
  noticeTitle: 'Welcome back',
  notice:
    'You played somewhere else while this device was offline. Story progress from this device was kept; health, mana, and position come from your latest session.',
  dismiss: 'Got it'
}

export const accountCopy = {
  section: 'Your world',
  signedInAs: (name: string) => `Signed in as ${name}`,
  /** The title, after the server forgot this sign-in. */
  signInEnded: 'Your sign-in ended. Sign in again to play in your world.',
  saved: 'Your journey saves to your world as you play.',
  savedOffline: 'Offline: your journey saves on this device and goes up when you reconnect.',
  savedTrouble: 'The world server is having trouble. Your journey saves on this device and goes up once it recovers.',
  logout: 'Log out',
  logoutTitle: 'Log out of your world?',
  logoutBody: 'Your journey stays in your world. You’ll return to the title screen, and sign in again to keep playing.',
  logoutDirty: 'Some progress hasn’t reached your world yet. If you log out now, this device keeps it until you sign in again.',
  uploadFirst: 'Continue to upload first',
  logoutAnyway: 'Log out anyway',
  titleChip: 'In your world',
  titleChipOffline: 'Offline · saves on this device'
}

export const inviteCopy = {
  section: 'Invite a friend',
  intro: 'Invite codes let a friend join your world. Each works once and lasts 30 days.',
  /** In a party's world, which takes no codes. */
  partyWorld: 'This world is for your party alone, so it takes no invite codes. Invite friends from a world of your own.',
  /** Let in through a party: no codes anywhere (the server refuses them too). */
  partyAdmitted: 'You came in with your party, so codes aren’t yours to give. Friends get one from whoever keeps this server, or from a friend they invited.',
  budgetLine: (left: number, total: number) => `${left} of ${total} invite codes left`,
  waitingLine: (limit: number) => `Up to ${limit} can wait at once.`,
  pasteHint: 'Your friend pastes it in “Have an invite code?” when they connect.',
  create: 'Create an invite code',
  creating: 'Making a code…',
  shownOnce: 'Copy it now: it’s only shown once.',
  copy: 'Copy',
  copied: 'Copied',
  outstanding: 'Waiting to be used',
  none: 'No codes waiting.',
  revoke: 'Revoke',
  limit: (n: number = INVITE_LIMIT) => `You have ${n} codes waiting already. Revoke one to make another.`,
  budget: `You’ve made all ${INVITE_LIFETIME} of your invite codes. Ask the world’s owner for more.`,
  flagged: 'Invites are paused for this account. The world’s owner can help.',
  signedOut: 'Your sign-in ended. Sign in again to manage invites.',
  used: 'Used',
  usedTitle: 'Already used',
  failed: 'That didn’t work. Try again in a moment.',
  offline: 'Invites need a connection.',
  expires: (when: string) => `Expires ${when}`,
  created: (when: string) => `Made ${when}`
}
