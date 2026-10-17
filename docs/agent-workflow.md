# Agent workflow

How the owner and an orchestrator agent run AI coding agents on Glimway. Agents are run through
Paseo on the development server.

## Roles

- **The owner** decides direction, playtests `dev`, and runs every deploy.
- **The orchestrator** writes briefs, starts and checks agents, reviews their work, commits, and
  merges. **Agents don't commit.**
- **Agents** work one lane each, in their own git worktree on an `exp/<lane>` branch, and write
  their notes into `.agent/` (git-ignored) in that worktree.

## Lanes

1. Create a worktree workspace in Paseo:
   - MCP: `create_workspace` with `isolation: "worktree"`, `mode: "branch-off"`,
     `branchName: "exp/<lane>"` and `baseBranch: "origin/dev"`.
   - CLI: `paseo workspace create --isolation worktree --mode branch-off --new-branch exp/<lane> --base origin/dev`.
2. Put the brief in `<worktree>/.agent/BRIEF.md`.
3. Start the agent in that workspace:
   - MCP: `create_agent` with `provider`, `workspaceId` and a short `initialPrompt`, such as
     "Read .agent/BRIEF.md and do it."
   - CLI: `paseo run --provider <provider/model> --workspace <id> "<prompt>"`.
4. Leave `notifyOnFinish` on. The orchestrator is told when the agent finishes, errors or needs
   permission, so don't poll. Send follow-ups with `send_agent_prompt` (CLI: `paseo send <id>`).
5. Review the diff, commit, and merge to `dev`. See [releasing.md](releasing.md).
6. Archive the agent and workspace once the lane has merged.

Keep `exp/*` branches local. Don't push them.

Two things Paseo needs on this machine:

- **Git LFS.** Paseo's own git calls run with a bare PATH, so the LFS filters must name the
  binary by its absolute path in the repo's local config:
  `git config --local filter.lfs.process "/run/current-system/sw/bin/git-lfs filter-process"`,
  and the same for `filter.lfs.clean` (`… clean -- %f`) and `filter.lfs.smudge`
  (`… smudge -- %f`). Done 2026-10-17. If a worktree checkout still fails, make it with
  `git worktree add` yourself (with git-lfs on PATH), then adopt it with `create_workspace`
  `isolation: "local"` and that `path`.
- **A mode for Codex agents.** `create_agent` from a Claude orchestrator can't inherit its mode
  into a Codex agent; pass `settings.modeId: "auto"` (and `thinkingOptionId`).

## Providers

| Use | Paseo provider string |
|---|---|
| Hard backend work, reviews, debugging | `codex/gpt-6.1-sol`, thinking `medium` or `high` |
| Art and light jobs | `codex/gpt-6-luna` |
| UI and design work, careful reviews | `claude/claude-opus-5-5` |
| Cheap, bounded lanes | `pi/<model>`. Check `paseo provider models pi` for what's set up. |

Antigravity (Gemini) isn't installed on the server yet.

## The development server

Development runs on the same machine as the live game, so:

- Work only in the checkout and its worktrees. Never touch the live service, its data, or
  `/etc/nixos`.
- Run builds and tests inside the dev shell, at low priority: `nix develop -c nice -n 10 npm run verify`.
  Node, Go and git-lfs exist only in the dev shell.
- Dev servers use their own ports and a fresh `-db`.
- Run unit tests, Go tests and `verify` locally. Don't run E2E on the host: paseo agents can't
  start Vite (the service lacks `AF_NETLINK`), and E2E bogs the machine down. Instead push your
  `exp/<lane>` branch and wait for CI in the foreground (`gh run watch <id> --exit-status`). On
  `exp/*` the self-hosted GPU job runs only the specs your changes touch (`npm run test:changed`
  against `origin/dev`), plus the smoke tier on GitHub. `dev` and `main` run the full suite. See
  [testing.md](testing.md).
