# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Plain plans.** A `.scratch/<plan>/` folder with no `map.md` but two or more numbered ticket files shows up as a plan tab. `▶` starts its tickets with a configurable `planPrompt` instead of `/wayfinder`, and a session started that way holds its ticket. New settings: `planPrompt` and `ignoreDirs`.
- Ticket fields written inline and in bold (`**When:** Thu · **Owner:** Nick · **Depends on:** 02`), `Depends on:` as an alias for `Blocked by:`, and closing a ticket with no `Status:` line when every checkbox is ticked.
- **this tab** in the start confirmation runs `/wayfinder <map> <ticket>` in the current session. The confirmation shows this session's context use and suggests this tab when it is under 60% of its budget and holds no ticket.
- A session started with `/wayfinder <map> <ticket>` (as ▶ starts them) shows that ticket as its own from the first turn, and every other tab shows it as claimed, before the claim reaches the ticket file.
- Context bars: this session's context fill and that of each other tab holding a ticket, against a per-session budget (`contextBudget`, default 200k).

### Fixed
- The plain `Assignee:` line now counts as a claim. Before, only frontmatter `assignee` did, so a ticket claimed the way the wayfinder skill writes it stayed under Ready. `none`, `-` and `unassigned` mean unclaimed.
- `Blocked by: none (02 and 09 closed)` no longer reads the note as a blocker.

### Changed
- The sidebar opens on the first map or plan with open tickets instead of the first one found.
- Keys: `i` / `k` move up and down, `j` / `l` move across a row's buttons, Enter presses the focused button, `r` refreshes, `d` shows resolved tickets and `p` picks. `o`, `s`, `g` and `x` are gone.
- Confirmation buttons no longer have letter keys. Click them, or focus one and press Enter. They are now named **handoff + new tab** and **fresh tab**.
- Tokyo Night colors (from LazyVim), with row tints mixed into the pane's grey, and a bold outline around the pane.
- Key hints sit in a bar pinned to the bottom of the docked pane.
- Context bars and claimed rows name tickets and context use instead of short session ids.
- New banner bar at the top of the pane: ◈ WAYFINDER on the left, ready / claimed / blocked / done counts on the right.
- The map destination wraps to two lines instead of being cut at one, and markdown such as `**bold**` is shown as plain text.
- A selected ticket's details name the ticket it unblocks next (preferring one that becomes ready), with a count of the rest, instead of a bare count.

## [0.1.0]

### Added
- Sidebar listing a wayfinder map's open tickets as Ready, Claimed and Blocked, colored by type.
- `▶` to start a new Claude Code session on a ticket, with an optional handoff from the current session.
- Picking several ready tickets and starting them with one shared handoff.
- Local markdown maps (`.scratch/<effort>/map.md`) and GitHub maps (`wayfinder:map` issues).
- Claim tracking across tabs, and a flash when tickets become unblocked.
- Linux fallbacks: `xdg-open` for opening tickets, and the clipboard for launch commands.
