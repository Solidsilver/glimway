/**
 * Holding the world still while something loads before a conversation opens
 * (Silas reads his plot book first). The hold sets the shared
 * `dialogueOpen` flag. The conversation, once it opens, owns that flag. If
 * the hold's owner ends first (its scene shut down or destroyed), `release`
 * lets go. A hold that is no longer held never touches the flag, so a late
 * load can't clear a newer conversation's.
 */
export class DialogueHold {
  private held = false
  private readonly ui: { dialogueOpen: boolean }

  constructor(ui: { dialogueOpen: boolean }) {
    this.ui = ui
  }

  /** Freeze the world for the wait. */
  take(): void {
    this.held = true
    this.ui.dialogueOpen = true
  }

  /** The conversation is opening: it owns the flag from here. */
  settle(): void {
    this.held = false
  }

  /** The owner ended before the conversation opened: unfreeze, once. */
  release(): void {
    if (!this.held) return
    this.held = false
    this.ui.dialogueOpen = false
  }
}
