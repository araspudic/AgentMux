# AgentMux

A small tmux-style terminal multiplexer for Linux (Ubuntu), made for running several
GitHub Copilot CLI / Claude Code sessions side by side. Copilot is the default profile and runs as
`copilot --yolo` (auto mode: no confirmation for every command).

- **Groups** in the left sidebar (one per project/folder), each with its own terminals.
- **Split layouts** per group: presets (`1`, `1|1`, `1|1|1`, `1|2`, `2|1`, `1|3`, `2x2`, `1/1`) or custom
  splits (split right / down on any pane, drag the dividers).
- **Fullscreen panes get their own view** (`□`, Ctrl+Shift+Z): the pane leaves the main split and is shown alone;
  split it there (`│` / `─` / presets) and those panes stay in that view, the main split is never touched.
  `■` puts a pane back into the main split. Switch views with `view 1 2 3` in the toolbar, the sidebar or
  Ctrl+Shift+[ / ]; in the sidebar a lone fullscreen pane is marked `□`, a split view `⊞` with its panes bracketed `┌ │ └`.
- **Agent status** per pane in the sidebar and pane header: `|/-\` spinner = working, blinking `!` + yellow =
  waiting for you to pick / confirm something, green `✓` = finished your request, `x` = exited.
- "Needs your answer" pops a toast bottom-left with the group › pane/session name (and a desktop notification
  when the window isn't focused); clicking it opens that pane. Ctrl+Shift+J jumps to the next pane that's asking.
  Desktop notifications need a notification daemon (GNOME/KDE have one; on XFCE: `sudo apt install xfce4-notifyd`).
- **Fork** (toolbar `fork`, pane `Y`, Ctrl+Shift+F), asks for a name:
  - Copilot: types `/fork <name>` into the session — the pane continues as the new fork, the original session
    stays saved (`/resume` to reopen it);
  - Claude: `claude --resume <id> --fork-session` in a new pane.
- **Font sizes**: `ui - +` (sidebar, toolbar, pane headers) and `term - +` (terminals) at the bottom of the sidebar.
- The focused pane has a blue header and frame; the other panes are dimmed.
- Double-click a pane/group name to rename. Layout, groups, fonts and profiles are saved and restored.
- Claude panes resume their own conversation after an app restart (↻ restart = fresh session).

Real PTYs (node-pty) rendered with xterm.js in Electron. `wwwroot/lib/` bundles
[xterm.js](https://github.com/xtermjs/xterm.js) 5.5.0 and its fit / webgl / unicode11 addons (MIT, © the xterm.js authors).

## Install

Download the `.deb` from [Releases](https://github.com/araspudic/AgentMux/releases):

```bash
sudo apt install ./agentmux_1.0.2_amd64.deb   # then run: agentmux  (or from the app menu)
```

The .deb pulls in its libraries and installs an AppArmor profile (`/etc/apparmor.d/agentmux`) so Electron's
sandbox works on Ubuntu 23.10+. `AgentMux-1.0.2.AppImage` is for other distros (needs libfuse2).

## Build

Needs Node 18+:

```bash
sudo apt install nodejs npm build-essential python3
./build.sh        # -> dist/agentmux_<version>_amd64.deb, dist/AgentMux-<version>.AppImage
```

## How agent status works

Claude panes are started with `--settings ~/.config/AgentMux/claude-hooks.json`. Those Claude Code hooks
(prompt submitted, permission/question asked, tool finished, notification, stop) report the state and session id
to AgentMux over a token-protected local socket on 127.0.0.1.

Copilot has no hooks, so AgentMux reads the bottom of its screen while it's drawing:

1. **needs your answer** only for a prompt that blocks Copilot until you choose/confirm: a selection menu at the
   very bottom (cursor line `❯ 1. …` + another numbered option, with a `…?` question right above it or a key hint
   like `Enter to select` / `↑↓` right below it), or a `(y/n)` prompt on the last lines. It has to stay on screen
   for half a second. Warnings, numbered lists in answers and "Do you want me to …?" sentences don't count;
2. a busy hint (`Esc to cancel`, `esc to interrupt`) → **working**;
3. otherwise output activity: a burst of output → working, output stops → **done**.

Pressing Esc on a pane that shows `!` clears it (and that prompt is ignored until it leaves the screen).

## Config

Config and state live in `~/.config/AgentMux/` (⚙ button in the sidebar; restart the app to apply).
Profiles run as `$SHELL -lc "<command>"`, e.g. `"claude; exec \"$SHELL\" -l"` — you're left in a shell in
the same folder when the CLI exits.

`"gpu": "auto"` (default) turns off GPU rendering when there's no GPU (VMs, remote desktop): Chromium's software
GPU emulation costs a lot of CPU there. Use `"on"` / `"off"` to force it.

## Keys

| Keys | Action |
| --- | --- |
| Ctrl+Shift+N | New group |
| Ctrl+Shift+PgUp / PgDn | Previous / next group |
| Ctrl+Shift+T | New terminal with the group's profile |
| Ctrl+Shift+D / E | Split pane right / down |
| Ctrl+Shift+Arrows | Move focus |
| Ctrl+Shift+Z | Fullscreen pane (own view) / back into the main split |
| Ctrl+Shift+[ / ] | Previous / next view |
| Ctrl+Shift+F | Fork focused session |
| Ctrl+Shift+J | Jump to the pane that needs an answer |
| Ctrl+Shift+R / W | Restart / close pane |
| Ctrl+Shift+B | Toggle sidebar |
| Ctrl+Shift+ = / - / 0 | Font size |
| Ctrl+C with selection, right-click | Copy |
| Ctrl+V, Ctrl+Shift+V, right-click | Paste |
| Shift+Enter | Newline in the Claude prompt |
