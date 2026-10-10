/**
 * The ways into Silas's Yard's two panels from the game (silas-yard.md 2.5,
 * 2.6): the Yard panel (src/ui/YardPanel.svelte) on a tab, as a display in
 * the shop opens its own, or on its default (Build while an upgrade is open
 * to you, otherwise Furnish); and Pell's Manage your deed panel
 * (src/ui/DeedPanel.svelte). App.svelte opens either only while no other
 * panel is up.
 */
import { bus, EV, type YardTab } from './events.ts'

export function openYard(tab?: YardTab): void {
  bus.emit(EV.homeShop, tab ? { tab } : {})
}

export function openDeedPanel(): void {
  bus.emit(EV.homeDeed)
}
