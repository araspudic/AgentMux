# AgentMux

A small tmux-style terminal multiplexer for Linux (Ubuntu), made for running several
Claude Code / Copilot CLI sessions side by side.

- **Groups** in the left sidebar (one per project/folder), each with its own terminals.
- **Split layouts** per group: presets (`1`, `1|1`, `1|1|1`, `1|2`, `2|1`, `1|3`, `2x2`, `1/1`) or custom
  splits (split right / down on any pane, drag the dividers).
- **Per-pane fullscreen**: some panes of a group can be fullscreen while the others stay split; the choice is remembered.
- **Agent status** per pane in the sidebar and pane header: `|/-\` spinner = working, blinking `!` = needs your
  answer (permission prompt or question), green `✓` = finished your request, `x` = exited.
- "Needs your answer" pops a toast bottom-right (and a desktop notification when the window isn't focused);
  clicking it opens that pane. Ctrl+Shift+J jumps to the next pane that's asking.
- **Fork** (toolbar `fork`, pane `Y`, Ctrl+Shift+F): forks the focused Claude session
  (`claude --resume <id> --fork-session`) into a new named pane. Double-click a pane/group name to rename.
- Claude panes resume their own conversation after an app restart (↻ restart = fresh session).
- Layout, groups and profiles are saved and restored.

Real PTYs (node-pty) rendered with xterm.js in Electron. `wwwroot/lib/` bundles
[xterm.js](https://github.com/xtermjs/xterm.js) 5.5.0 and its fit / webgl / unicode11 addons (MIT, © the xterm.js authors).

## Install

Download the `.deb` from [Releases](https://github.com/araspudic/AgentMux/releases):

```bash
sudo apt install ./agentmux_1.0.0_amd64.deb   # then run: agentmux  (or from the app menu)
```

The .deb pulls in its libraries and installs an AppArmor profile (`/etc/apparmor.d/agentmux`) so Electron's
sandbox works on Ubuntu 23.10+. `AgentMux-1.0.0.AppImage` is for other distros (needs libfuse2).

## Build

Needs Node 18+:

```bash
sudo apt install nodejs npm build-essential python3
./build.sh        # -> dist/agentmux_1.0.0_amd64.deb, dist/AgentMux-1.0.0.AppImage
```

## How agent status works

Claude panes are started with `--settings ~/.config/AgentMux/claude-hooks.json`. Those Claude Code hooks
(prompt submitted, permission/question asked, tool finished, notification, stop) report the state and session id
to AgentMux over a token-protected local socket on 127.0.0.1. Copilot has no hooks, so its state is inferred from
its output (activity bursts and on-screen question prompts).

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
| Ctrl+Shift+Z | Fullscreen pane |
| Ctrl+Shift+F | Fork focused Claude session |
| Ctrl+Shift+J | Jump to the pane that needs an answer |
| Ctrl+Shift+R / W | Restart / close pane |
| Ctrl+Shift+B | Toggle sidebar |
| Ctrl+Shift+ = / - / 0 | Font size |
| Ctrl+C with selection, right-click | Copy |
| Ctrl+V, Ctrl+Shift+V, right-click | Paste |
| Shift+Enter | Newline in the Claude prompt |
