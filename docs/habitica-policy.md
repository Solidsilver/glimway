# Habitica's rules for third-party tools, and our plan

Fingersnap is a third-party tool built on Habitica's API. This page sums up what Habitica asks of
such tools, where we stand today, and the plan for telling Habitica staff about the game. The gold
research behind the purse is in [habitica-gold.md](habitica-gold.md), and what the game may take
from Habitica is in [habitica-boundary.md](habitica-boundary.md).

## Sources

- [API Usage Guidelines](https://github.com/HabitRPG/habitica/wiki/API-Usage-Guidelines) on
  Habitica's GitHub wiki (last changed 2024-06-19).
- The fandom wiki's [Guidance for Comrades](https://habitica.fandom.com/wiki/Guidance_for_Comrades),
  including its third-party tool rules (revised 2025-05-25), and
  [Application Programming Interface](https://habitica.fandom.com/wiki/Application_Programming_Interface)
  (2025-08-30).

## What Habitica asks

- **Identify the tool.** Every call carries an `x-client` header,
  `<creator's user id>-<app name>`: the ID of the person who **wrote** the tool, not the player using
  it. Since late July 2025, authenticated calls without it are rejected.
- **Use API v3 only.** v4 "is not suitable for use in any third-party tools for any reason".
- **Respect the rate limit.** 30 requests every 60 seconds per user. A 429 says when to retry.
- **Pace background scripts.** Automated scripts that run with no player action should wait 30
  seconds between calls, especially writes.
- **Stop when an action can't complete.** For example, stop buying when the player runs out of gold.
- **Be open about tokens.** If a tool stores API tokens, say so plainly on its front page and in its
  docs.
- **Publish the code** if other people use the tool.
- **Tell staff.** Submit the tool on the app-submission form
  ([forms.habitica.com/app-submission](https://forms.habitica.com/app-submission)) "as soon as your
  code is ready". Email admin@habitica.com "if you expect many players to use your tool".

The rules don't mention gold or editing user data, except for the stop-when-you-can't rule. The form
is a heads-up, not an approval step. Tools don't need permission to use the API.

## Where Fingersnap stands today (read-only)

| Rule | Status |
|---|---|
| `x-client` header | Done. The server sends `<owner id>-fingersnap` (`server/cmd/fingersnap-server/main.go`). |
| API v3 only | Done. |
| Rate limit | Done. Sign-in makes a handful of calls, and our own login limits sit well below Habitica's. |
| Background pacing | Not applicable. Nothing runs without the player. |
| Stop on failure | Not applicable while read-only. The purse design follows it. |
| Token openness | Done. The server never stores the token. The opt-in "remember" keeps it only in the player's browser, and the connect guide says so. |
| Public code | **Not yet.** The repo has no remote and isn't public. |
| Told staff | **Not yet.** Planned once it's polished (below). |

**Using the read-only game on your own account is fine.** Reading your own profile with your own
token is what the API is for. A tool doesn't need to be registered before you or friends use it, and
the form is a courtesy heads-up. Everything the game does today is reads, at sign-in, well under the
rate limit, with the right header. Writes are what deserve extra care: they change a player's real
data, and Habitica keeps no gold history. That's why the gold purse gets tested against a throwaway
account first.

## When the gold purse arrives

The purse makes three writes during one top-up the player starts: create a reward, buy it, delete
it. See [habitica-gold.md](habitica-gold.md).
- **Pacing:** the 30-second rule is for background scripts, and a top-up is started by the player,
  so it shouldn't apply. Mention it when submitting anyway.
- **"Read-only" copy:** the README, the connect guide and the import contract all promise the game
  is read-only. Change all three in the same release as the purse.
- **Testing:** test against a throwaway Habitica account before any real one.

## Plan for telling Habitica

When the game is reasonably polished and before the gold purse reaches other players:
1. **Decide on public code.** The guidelines expect tools used by others to publish their code. Either
   publish the repo, for example on GitHub with a licence and the README, or decide to keep the game
   to a small private group and say so when submitting.
2. **Check the identity.** Confirm the `x-client` ID is the owner's Habitica user ID and the app
   name reads well.
3. **Check the token wording** on the front page and in the connect guide.
4. **Submit the form,** describing what the game reads and, if the purse is in, exactly what it
   writes, how often, and the consent screen.
5. **Email admin@habitica.com only** if it's opened to many players.
