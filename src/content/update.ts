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
  /** The Menu's quiet line, linking to the changelog. */
  menuLine: (version: string) => `Glimway ${version}`,
  menuBuild: (build: string) => `build ${build}`,
  menuTitle: 'What’s new: the changelog on GitHub'
}
