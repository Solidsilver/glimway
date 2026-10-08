/** The "new version" notice (src/ui/UpdateNotice.svelte) and the Menu's version line. */
export const updateCopy = {
  title: 'A new version of Glimway is ready.',
  note: 'Reload when it suits you. Your progress is saved first.',
  reload: 'Reload',
  reloading: 'Saving…',
  later: 'Later',
  /** Reload held back: something hasn't saved yet. */
  offline: 'You’re offline, so your latest steps are only on this device. Reload once you’re back online.',
  unsaved: 'Your latest steps haven’t saved yet, so we didn’t reload. Try again in a moment.',
  /** The world server refused this client's contract (design section 8). */
  contractTitle: 'This page is older than the world server.',
  contractNote: 'Reload to keep playing. Nothing can be written until you do.',
  /** The Menu's quiet line, linking to the changelog. */
  menuLine: (version: string) => `Glimway ${version}`,
  menuBuild: (build: string) => `build ${build}`,
  menuTitle: 'What’s new: the changelog on GitHub'
}

/** The "What's new" card (src/ui/WhatsNew.svelte), fed by CHANGELOG.md's "For players" lines. */
export const whatsNewCopy = {
  /** One release since you last played. */
  title: (version: string) => `New in Glimway ${version}`,
  /** Several. */
  titleSince: 'New since you were last here',
  /** Each release's heading when there are several. */
  release: (version: string) => `Glimway ${version}`,
  ok: 'Off we go',
  all: 'Everything that changed',
  /** The Menu's button beside the version line. */
  menu: 'What’s new',
  /** Opened from the Menu on a build with nothing written up yet. */
  nothing: 'Nothing new to tell yet. The lamps are just as you left them.'
}
