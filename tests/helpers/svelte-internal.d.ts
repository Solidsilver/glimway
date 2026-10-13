// Svelte's internal client entry has no published declarations. These are the
// runtime functions used by the component-effect test harness.
declare module 'svelte/internal/client' {
  export function effect_root(fn: () => void): () => void
  export function flush(): void
  export function user_effect(fn: () => void): void
}
