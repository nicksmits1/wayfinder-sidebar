<div align="center">

<img src=".claude-plugin/icon.png" width="96" alt="">

# wayfinder-sidebar

**Your [`/wayfinder`](https://github.com/mattpocock/skills) map beside the chat. Click ▶ on a ticket and a new Claude Code session starts working on it, with a handoff from this one.**

[![CI](https://github.com/nicksmits1/wayfinder-sidebar/actions/workflows/ci.yml/badge.svg)](https://github.com/nicksmits1/wayfinder-sidebar/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Claude Code 2.1.275+](https://img.shields.io/badge/Claude%20Code-2.1.275%2B-d97757)

<table>
  <tr>
    <td width="50%"><img src="assets/demo.gif" alt="Pressing ▶ on a ready ticket and choosing fresh tab opens a new iTerm tab working it, and the first tab shows the ticket as claimed"></td>
    <td width="50%"><img src="assets/sidebar.png" alt="The sidebar beside the chat, with the start confirmation open under a ready ticket"></td>
  </tr>
  <tr>
    <td align="center"><sub>Start a ticket in a new tab</sub></td>
    <td align="center"><sub>The map beside the chat</sub></td>
  </tr>
</table>

</div>

```
▐ ◈ WAYFINDER               4 ▸  2 ◐  10 ⧗  ✓ 5 ▌
◎ I4 submitted on Canvas
──────────────────────────────────────────────────
▸ Ready 4
▐ grill  07 P3: user-confirmed paym…        md  ▶ ▌
▐ task   10 Enforce bag allowance s…        md  ▶ ▌
◐ Claimed 2
▐ grill  06 P1 & P2: server-side co… ⠹ you  md  ▶ ▌
▐ task   09 Implement identity & se… ⠹181k  md  ▶ ▌
⧗ Blocked 10
▐ task   13 Implement P1/P2 policy … 06 +2  md  ▶ ▌

◔ Context · 200k a session
  you 06 P1 & P2: serv…  ████████▏░░░░░░░░░░░  92k
  09 Implement identi…   ██████████████████▉░ 181k
```

- **See what can move.** Open tickets are grouped into Ready, Claimed and Blocked, and colored by type.
- **Start work in one click.** `▶` opens a new terminal tab running `/wayfinder <map> <ticket>`.
- **Keep context.** Before launching, this session can write a handoff note for the new one.
- **Run here or in a new tab.** Start a ticket in this session, or in a new tab with or without a handoff.
- **Run several at once.** Pick a few ready tickets and start them together with one shared handoff.
- **Keep sessions small.** A bar per session shows its context against a 200k budget, following the wayfinder rule of one ticket per session and under 200k tokens. Bars turn yellow at 60% and red when over.
- **Stay in sync.** Every tab sees claims and resolutions from the others within seconds. Tickets flash when they become unblocked.

It only reads your tracker. It never edits your tickets or your wayfinder, grilling or handoff skill files.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install wayfinder-sidebar --marketplace nicksmits1/wayfinder-sidebar
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install wayfinder-sidebar --marketplace nicksmits1/wayfinder-sidebar
```

The sidebar opens on its own when the working directory has a map, and `/wayfinder-map` opens it any time. It docks beside the chat in fullscreen mode when the terminal is at least 110 columns wide.

### Requirements

- **Claude Code 2.1.275 or later** for the one-line install.
- **The [`wayfinder` skill](https://github.com/mattpocock/skills).** New sessions start with `/wayfinder`. [`handoff`](https://github.com/mattpocock/skills) is optional: when it's installed, its rules shape the handoff notes.
- **macOS** to open new sessions in iTerm or Terminal.app. On Linux, tickets open with `xdg-open` and the launch command is copied to your clipboard instead. Windows is untested.
- **The [`gh` CLI](https://cli.github.com), signed in,** for GitHub-hosted maps only.

## Using it

### Rows

- **Type chip.** The word at the left is the ticket type (`grill`, `proto`, `rsrch`, `task`) in its color. A solid chip means the ticket needs you (HITL). Colored text on a dark chip means an agent can run it alone (AFK).
- **Status.** Claimed tickets show a spinner and who holds them: `you` for this session, the context it has used (such as `181k`) for another tab running this mod, or `tab` otherwise. Blocked tickets show the ids they wait on, colored by those tickets' types.
- **Context.** One bar for this session (`you`), and one for each other tab running the mod that holds a ticket on this map. Each bar is labelled with the ticket its session is working on. Each tab reports its own figures after every turn.
- **Footer.** The map's "Not yet specified" items and resolved count sit at the bottom. Press `d` to list resolved tickets.

### Buttons and keys

Each row ends with `md` (or `gh`), which opens the ticket file in your editor or the issue in the browser, and `▶`, which starts a session on it. `▶` only works on ready tickets. Pressing it opens a confirmation under the row:

| Button | What it does |
|---|---|
| handoff + new tab | This session writes a handoff note, then offers **launch**, **view** and **discard** |
| fresh tab | Open a new tab now, with no handoff |
| this tab | Run `/wayfinder <map> <ticket>` in this session, keeping its context |
| cancel | Close the confirmation |

The line above the buttons shows this session's context use and whether it already holds a ticket. When it is under 60% of the budget and holds no ticket, **this tab** is highlighted as the suggested choice. Otherwise **handoff + new tab** is. "this tab" is not offered when several tickets are picked.

Every button works with a click, or with Enter once the focus is on it.

With the pane focused (`ctrl+x`):

| Key | Action | Key | Action |
|---|---|---|---|
| `i` / `k` | move up / down | `p` | pick a ready ticket (for multi-start) |
| `j` / `l` | move left / right across a row's buttons | `d` | show / hide resolved |
| Enter | press the focused button | `r` | refresh now |

Tab and the arrow keys also move the focus. To start several tickets, pick them with `p`, then press `▶` on any of them.

The mouse wheel scrolls the pane.

### Handoffs

The mod asks the current session to write the note, following the rules from the `handoff` skill (read from `~/.claude/skills/handoff/SKILL.md` when installed). Notes go in `$TMPDIR/wayfinder-handoffs/`, never in the repo. Starting several tickets writes one note with a section per ticket. A note is deleted once all its tickets close, or after a week. The new session starts as:

```
claude "/wayfinder <map> <ticket>  Context from the session that launched this one: read the \"## <ticket>\" section of <note> before anything else."
```

## Trackers

- **Local markdown:** `.scratch/<effort>/map.md`, with tickets in `tickets/` or `issues/`. Two ticket formats work: YAML frontmatter (`title`, `type`, `status`, `assignee`, `blocked_by`), or the skill doc's plain lines (`# Title`, `Type:`, `Status:`, `Blocked by:`).
- **GitHub:** open issues labelled `wayfinder:map` in the working directory's repository, read with `gh`. Tickets are the map's sub-issues (or a task list in its body when it has none), typed by `wayfinder:<type>` labels, and blocked by GitHub's native issue dependencies (or a `Blocked by: #n` line when a ticket has none).

Task tickets count as AFK unless the file has `hitl: true` or the issue has a `wayfinder:hitl` label.

Every Claude Code tab runs its own copy of the mod against the same tracker. A tab's own edits show at once. Other tabs' edits show within a few seconds, because the mod checks file modification times. GitHub maps refresh every 45 seconds.

A GitHub map costs two GraphQL requests a refresh (one more per 100 tickets), whatever the number of tickets, and the tabs open on one repository share each read, so more tabs do not mean more requests. When GitHub cannot be read, the pane keeps the tickets it had, shows the error under the map's title, and waits twice as long before each new try, up to 15 minutes. `r` reads again at once.

## Settings

Change these in `/plugin` → wayfinder-sidebar → configure, or under `pluginConfigs` in settings:

| Setting | Default | |
|---|---|---|
| `launcher` | `iterm` | `iterm` (new iTerm tab), `terminal` (new Terminal.app window) or `copy` (copy the command). Other systems always copy. |
| `editor` | system opener | Command that opens a ticket file, such as `code`, `cursor` or `zed` |
| `pollSeconds` | `3` | How often local files are checked |
| `githubSeconds` | `45` | How often GitHub maps are re-read, across all tabs. At least 10; a lower value counts as 45. |
| `contextBudget` | `200000` | Tokens per session where the context bar fills and turns red |

The first launch into iTerm or Terminal makes macOS ask whether Claude Code may control that app.

## Contributing

Bug reports, tracker formats seen in the wild, and launchers for other terminals (kitty, WezTerm, Ghostty, tmux, Linux terminals) are all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to run the mod from a clone and run its tests.

## Credits

Built for [Matt Pocock's skills](https://github.com/mattpocock/skills) (`wayfinder`, `grilling`, `handoff`). Ticket colors follow the Proschi plugin's palette.

## License

[MIT](LICENSE)
