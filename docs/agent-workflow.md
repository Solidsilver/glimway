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
- Run unit tests, Go tests and `verify` locally. A separate agent runs E2E, and the full suite
  runs in CI. See [testing.md](testing.md).
