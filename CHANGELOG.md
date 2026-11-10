# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **this tab** in the start confirmation runs `/wayfinder <map> <ticket>` in the current session. The confirmation shows this session's context use and suggests this tab when it is under 60% of its budget and holds no ticket.
- A session started with `/wayfinder <map> <ticket>` (as ▶ starts them) shows that ticket as its own from the first turn, and every other tab shows it as claimed, before the claim reaches the ticket file.
- Context bars: this session's context fill and that of each other tab holding a ticket, against a per-session budget (`contextBudget`, default 200k).

### Changed
- Keys: `i` / `k` move up and down, `j` / `l` move across a row's buttons, Enter presses the focused button, `r` refreshes, `d` shows resolved tickets and `p` picks. `o`, `s`, `g` and `x` are gone.
- Confirmation buttons no longer have letter keys. Click them, or focus one and press Enter. They are now named **handoff + new tab** and **fresh tab**.
- Tokyo Night colors (from LazyVim), with row tints mixed into the pane's grey, and a bold outline around the pane.
- Key hints sit in a bar pinned to the bottom of the docked pane.
- Context bars and claimed rows name tickets and context use instead of short session ids.
- New banner bar at the top of the pane: ◈ WAYFINDER on the left, ready / claimed / blocked / done counts on the right.
- The map destination wraps to two lines instead of being cut at one, and markdown such as `**bold**` is shown as plain text.
- A selected ticket's details name the ticket it unblocks next (preferring one that becomes ready), with a count of the rest, instead of a bare count.
- GitHub maps are read over GraphQL: a map's sub-issues and their blockers arrive in one request, instead of one REST request for the map and one more per open ticket.
- The tabs open on one repository share each read of GitHub, so it is asked once per `githubSeconds` however many tabs are open, and a tab shows another tab's read within seconds.
- A ticket with no native blockers is blocked by its `Blocked by: #n` body line, and a map with no sub-issues reads the task list in its body. Before, both applied only when the REST request failed.

### Fixed
- A GitHub map showed no tickets, and no error, once the REST sub-issue and dependency endpoints were rate-limited. GitHub counts those endpoints apart from the limit `gh api rate_limit` reports, and a few open tabs used it up. A read that fails now keeps the tickets, shows the error under the map's title, and doubles the wait before the next try (up to 15 minutes).

## [0.1.0]

### Added
- Sidebar listing a wayfinder map's open tickets as Ready, Claimed and Blocked, colored by type.
- `▶` to start a new Claude Code session on a ticket, with an optional handoff from the current session.
- Picking several ready tickets and starting them with one shared handoff.
- Local markdown maps (`.scratch/<effort>/map.md`) and GitHub maps (`wayfinder:map` issues).
- Claim tracking across tabs, and a flash when tickets become unblocked.
- Linux fallbacks: `xdg-open` for opening tickets, and the clipboard for launch commands.
