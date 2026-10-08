/// <reference types="svelte" />
/// <reference types="vite/client" />

/** package.json's version and this build's id (scripts/build-version.mjs; "dev" under the dev server). */
declare const __GLIMWAY_VERSION__: string
declare const __GLIMWAY_BUILD__: string

/** CHANGELOG.md's released versions with their "For players" lines (scripts/whats-new.mjs). */
declare module 'virtual:whats-new' {
  const releases: import('./lib/changelog').Release[]
  export default releases
}
