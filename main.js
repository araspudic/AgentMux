'use strict';
// AgentMux (Linux + Windows): Electron shell around the UI in ./wwwroot, terminals via node-pty
// (Linux: $SHELL -lc "<command>"; Windows: PowerShell -NoExit -Command <command> in a ConPTY).

const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Menu, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const pty = require('node-pty');

// AGENTMUX_DATA lets a second (test) instance run with its own groups/state.
const IS_WIN = process.platform === 'win32';
// (on Windows this is %APPDATA%\AgentMux, the same folder the old WinForms AgentMux used: its groups carry over)
const DATA_DIR = process.env.AGENTMUX_DATA || path.join(app.getPath('appData'), 'AgentMux');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const WINDOW_PATH = path.join(DATA_DIR, 'window.json');
const HOOK_SCRIPT = path.join(DATA_DIR, 'claude-hook.sh');
const HOOK_SETTINGS = path.join(DATA_DIR, 'claude-hooks.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
app.setPath('userData', path.join(DATA_DIR, 'chromium'));

// Linux: profile commands run as `$SHELL -lc "<command>; exec $SHELL -l"` (you're left in a shell in the same
// folder when the CLI exits). Windows: `powershell -NoExit -Command <command>` already stays open, so no tail.
const SHELL_TAIL = 'exec "$SHELL" -l';
const tail = (cmd) => (IS_WIN ? cmd : `${cmd}; ${SHELL_TAIL}`);
const DEFAULT_CONFIG = {
  fontFamily: IS_WIN ? "'Cascadia Mono', Consolas, 'Courier New', monospace"
    : "'DejaVu Sans Mono', 'Ubuntu Mono', 'Cascadia Mono', 'Liberation Mono', monospace",
  fontSize: 15,   // terminals (also the sidebar footer "term - +")
  uiFontSize: 15, // sidebar / toolbar / pane headers (sidebar footer "ui - +")
  scrollback: 10000,
  cursorBlink: false,
  // "auto": use the GPU only if the machine has one (no /dev/dri render node, or an RDP session = software only).
  // Chromium's software GPU emulation is very CPU-heavy, so "off" is much faster on VMs.
  gpu: 'auto',
  configVersion: 3,
  defaultProfile: 'Copilot',
  // command: what a new pane runs (Linux: $SHELL -lc "<command>"; Windows: <shell> -NoExit -Command <command>,
  // empty = just the shell). Windows only: "shell" = the shell to use (default powershell.exe; pwsh.exe works too).
  // resume / fork: used when AgentMux knows the Claude session id ({session}) — after an app restart / for the fork button.
  // forkInPane: typed into the running session by the fork button ({name} = the name you enter).
  // copilot --yolo = allow all tools/paths/urls without asking (auto mode).
  profiles: [
    { name: 'Copilot', command: tail('copilot --yolo'), forkInPane: '/fork {name}' },
    { name: 'Claude', command: tail('claude'),
      resume: tail('claude --resume {session}'),
      fork: tail('claude --resume {session} --fork-session') },
    { name: IS_WIN ? 'PowerShell' : 'Shell', command: IS_WIN ? '' : SHELL_TAIL },
  ],
};
if (IS_WIN) DEFAULT_CONFIG.shell = 'powershell.exe';
const CLAUDE_DEFAULTS = DEFAULT_CONFIG.profiles.find((p) => p.name === 'Claude');

function readJson(p) {
  try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8').trimStart() /* also drops a UTF-8 BOM */) : null; }
  catch { try { fs.copyFileSync(p, p + '.broken'); } catch {} return null; }
}
function writeAtomic(p, text) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

// config: create, or add the new keys to an existing one (keeps the user's edits)
let config = readJson(CONFIG_PATH);
if (!config) {
  config = DEFAULT_CONFIG;
  writeAtomic(CONFIG_PATH, JSON.stringify(config, null, 2));
} else {
  let changed = false;
  // Windows: config of the old WinForms AgentMux (no configVersion; profiles were whole command lines such as
  // "powershell.exe -NoLogo -NoExit -Command claude"). Keep a backup of its files, then convert the profiles.
  if (IS_WIN && !config.configVersion && !config.shell) {
    for (const f of [CONFIG_PATH, STATE_PATH, WINDOW_PATH]) {
      try { if (fs.existsSync(f) && !fs.existsSync(f + '.winforms-backup')) fs.copyFileSync(f, f + '.winforms-backup'); } catch {}
    }
    for (const p of config.profiles || []) {
      const c = String(p.command || '').trim();
      const m = c.match(/^(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*?-(?:Command|c)\s+(.+)$/i);
      if (m) p.command = m[1];
      else if (/^(?:powershell|pwsh)(?:\.exe)?(\s+-NoLogo)?\s*$/i.test(c)) p.command = '';
    }
    config.shell = DEFAULT_CONFIG.shell;
    changed = true;
  }
  if (IS_WIN && !config.shell) { config.shell = DEFAULT_CONFIG.shell; changed = true; }
  for (const k of ['gpu', 'cursorBlink']) if (!(k in config)) { config[k] = DEFAULT_CONFIG[k]; changed = true; }
  for (const p of config.profiles || []) {
    if (/^\s*claude(\s|;|$)/.test(p.command || '') && !p.fork) {
      p.resume = CLAUDE_DEFAULTS.resume;
      p.fork = CLAUDE_DEFAULTS.fork;
      changed = true;
    }
  }
  // v2: Copilot is the first and default profile (also for groups that still had the old default, Claude)
  if (!(config.configVersion >= 2)) {
    const isCopilot = (p) => /(^|[\s;&|(])copilot(\s|;|$)/.test(p.command || '');
    const list = Array.isArray(config.profiles) ? config.profiles : [];
    if (!list.some(isCopilot)) list.push({ ...DEFAULT_CONFIG.profiles[0] });
    config.profiles = [...list.filter(isCopilot), ...list.filter((p) => !isCopilot(p))];
    const oldDefault = config.defaultProfile;
    config.defaultProfile = config.profiles[0].name;
    config.configVersion = 2;
    changed = true;
    const state = readJson(STATE_PATH);
    if (state && Array.isArray(state.groups)) {
      for (const g of state.groups) if (!g.defaultProfile || g.defaultProfile === oldDefault) g.defaultProfile = config.defaultProfile;
      writeAtomic(STATE_PATH, JSON.stringify(state));
    }
  }
  // v3: Copilot runs in auto mode (--yolo) and can be forked (/fork NAME); fonts 15% bigger
  if (!(config.configVersion >= 3)) {
    for (const p of config.profiles || []) {
      if (!/(^|[\s;&|(])copilot(\s|;|$)/.test(p.command || '')) continue;
      if (!/--(yolo|allow-all)\b/.test(p.command)) p.command = p.command.replace(/(^|[\s;&|(])copilot(?=\s|;|$)/, '$1copilot --yolo');
      if (!p.forkInPane) p.forkInPane = '/fork {name}';
    }
    const bigger = (n) => Math.round(n * 1.15);
    config.fontSize = config.fontSize ? bigger(config.fontSize) : DEFAULT_CONFIG.fontSize;
    if (!config.uiFontSize) config.uiFontSize = DEFAULT_CONFIG.uiFontSize;
    config.configVersion = 3;
    changed = true;
    const state = readJson(STATE_PATH);
    if (state && state.fontSize) { state.fontSize = bigger(state.fontSize); writeAtomic(STATE_PATH, JSON.stringify(state)); }
  }
  if (changed) writeAtomic(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ------------------------------------------------------------------ GPU

function hasUsableGpu() {
  if (IS_WIN) return !/^RDP-/i.test(process.env.SESSIONNAME || ''); // Remote Desktop = software rendering
  if (process.env.XRDP_SESSION || process.env.LIBGL_ALWAYS_SOFTWARE === '1') return false;
  try { return fs.readdirSync('/dev/dri').some((f) => f.startsWith('renderD')); } catch { return false; }
}
const useGpu = config.gpu === 'on' || (config.gpu !== 'off' && hasUsableGpu());
if (!useGpu) {
  // Plain software compositing. (--disable-gpu alone still runs SwiftShader, which costs ~40% of a core.)
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

// ------------------------------------------------------------------ Claude Code hooks
// Claude panes start with `claude --settings claude-hooks.json`; the hooks run claude-hook.sh, which sends
// "token / pane id / event / hook JSON" to this local socket. That's how AgentMux knows when Claude is
// working, needs an answer, or is done — and the session id used for fork / resume.

const HOOK_TOKEN = crypto.randomBytes(16).toString('hex');
let hookPort = 0;

const HOOK_SH = `#!/bin/bash
# Written by AgentMux. Called by Claude Code hooks; forwards the event to the AgentMux window.
[ -n "$AGENTMUX_PORT" ] && [ -n "$AGENTMUX_PANE" ] || exit 0
payload=$(head -c 200000)
exec 3<>"/dev/tcp/127.0.0.1/$AGENTMUX_PORT" 2>/dev/null || exit 0
printf '%s\\n%s\\n%s\\n%s' "$AGENTMUX_TOKEN" "$AGENTMUX_PANE" "$1" "$payload" >&3
exec 3>&-
exit 0
`;

// On Windows Claude Code runs hook commands with Git Bash, which mangles backslashes: use C:/… paths there.
const HOOK_SCRIPT_ARG = IS_WIN ? HOOK_SCRIPT.replace(/\\/g, '/') : HOOK_SCRIPT;
function hookSettings() {
  const cmd = (ev) => [{ type: 'command', command: `bash '${HOOK_SCRIPT_ARG}' ${ev}`, timeout: 5 }];
  return {
    hooks: {
      SessionStart: [{ hooks: cmd('session') }],
      UserPromptSubmit: [{ hooks: cmd('prompt') }],
      PreToolUse: [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: cmd('ask-tool') }],
      PostToolUse: [{ matcher: '*', hooks: cmd('tool-done') }],
      Notification: [{ hooks: cmd('notify') }],
      Stop: [{ hooks: cmd('stop') }],
    },
  };
}

function startHookServer() {
  fs.writeFileSync(HOOK_SCRIPT, HOOK_SH, { mode: 0o755 });
  writeAtomic(HOOK_SETTINGS, JSON.stringify(hookSettings(), null, 2));
  const server = net.createServer((sock) => {
    const chunks = [];
    let size = 0;
    sock.on('data', (c) => { size += c.length; if (size > 300000) sock.destroy(); else chunks.push(c); });
    sock.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const [token, pane, event, ...rest] = text.split('\n');
      if (token !== HOOK_TOKEN || !pane || !event) return;
      let data = {};
      try { data = JSON.parse(rest.join('\n') || '{}'); } catch {}
      send({
        type: 'agent', id: pane, event,
        info: {
          session: data.session_id || null,
          message: data.message || null,
          kind: data.notification_type || null,
          tool: data.tool_name || null,
        },
      });
    });
    sock.on('error', () => {});
  });
  server.listen(0, '127.0.0.1', () => { hookPort = server.address().port; });
  server.unref();
}

// `claude ...` at the start of a command (or after ; && ||) gets the hooks settings added
function withHooks(command) {
  const settings = IS_WIN ? `"${HOOK_SETTINGS.replace(/\\/g, '/')}"` : '"$AGENTMUX_CLAUDE_SETTINGS"';
  return command.replace(/(^|[;&|(]\s*)claude(?=\s|;|$)/g, `$1claude --settings ${settings}`);
}

// what to run in the terminal: Linux $SHELL -lc "<command>"; Windows <shell> -NoExit -Command <command>
// (passed as -EncodedCommand, so quotes and $ in the command survive the Windows command line)
function shellArgs(command) {
  if (!IS_WIN) {
    const sh = process.env.SHELL || '/bin/bash';
    return { file: sh, args: ['-lc', withHooks(command || SHELL_TAIL)], env: { SHELL: sh } };
  }
  const file = config.shell || 'powershell.exe';
  if (/(^|[\\/])cmd(\.exe)?$/i.test(file)) return { file, args: command ? `/k ${withHooks(command)}` : '', env: {} };
  const args = ['-NoLogo'];
  if (command) args.push('-NoExit', '-EncodedCommand', Buffer.from(withHooks(command), 'utf16le').toString('base64'));
  return { file, args, env: {} };
}

// ------------------------------------------------------------------ terminals

let win = null;
let quitting = false;
const notes = new Set(); // shown desktop notifications
const ptys = new Map();
let pending = {};
let flushTimer = null;

const clamp = (v, d) => Math.max(2, Math.min(2000, Number.isFinite(v) ? Math.floor(v) : d));

function send(m) {
  if (win && !win.isDestroyed()) win.webContents.send('host', m);
}

// batch output from all terminals into one message every few ms
function enqueue(id, data) {
  pending[id] = (pending[id] || '') + data;
  if (!flushTimer) flushTimer = setTimeout(flush, 8);
}
function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  const d = pending;
  pending = {};
  if (Object.keys(d).length) send({ type: 'out', d });
}

function spawn(m) {
  kill(m.id);
  let cwd = String(m.cwd || '').trim().replace(/^~(?=$|[\\/])/, os.homedir());
  if (!cwd || !fs.existsSync(cwd)) cwd = os.homedir();
  const sh = shellArgs(String(m.command || '').trim());
  let p;
  try {
    p = pty.spawn(sh.file, sh.args, {
      name: 'xterm-256color',
      cols: clamp(m.cols, 120),
      rows: clamp(m.rows, 30),
      cwd,
      useConptyDll: IS_WIN, // Windows: the newer ConPTY bundled with node-pty (better rendering than the system one)
      env: {
        ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...sh.env,
        AGENTMUX_PANE: m.id, AGENTMUX_PORT: String(hookPort), AGENTMUX_TOKEN: HOOK_TOKEN,
        AGENTMUX_CLAUDE_SETTINGS: HOOK_SETTINGS,
      },
    });
  } catch (err) {
    send({ type: 'spawn-error', id: m.id, message: String((err && err.message) || err) });
    return;
  }
  ptys.set(m.id, p);
  p.onData((d) => { if (ptys.get(m.id) === p) enqueue(m.id, d); });
  p.onExit(({ exitCode }) => {
    setTimeout(() => {
      if (ptys.get(m.id) !== p) return;
      ptys.delete(m.id);
      flush();
      send({ type: 'exit', id: m.id, code: exitCode });
    }, 50);
  });
}

// Kill the whole process group (the shell + claude/copilot it started), not just the shell.
function kill(id) {
  const p = ptys.get(id);
  if (!p) return;
  ptys.delete(id);
  delete pending[id];
  const pid = p.pid;
  if (IS_WIN) { try { p.kill(); } catch {} return; } // closing the ConPTY ends the programs attached to it
  try { process.kill(-pid, 'SIGHUP'); } catch {}
  try { p.kill(); } catch {}
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} }, 2000).unref();
}

function killAll() {
  for (const id of [...ptys.keys()]) kill(id);
}

function showPane(id) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  send({ type: 'open-pane', id });
}

// ------------------------------------------------------------------ messages from the page

ipcMain.on('host', (_e, m) => {
  try { handle(m || {}); } catch (err) { console.error(err); }
});

function handle(m) {
  switch (m.type) {
    case 'ready':
      send({
        type: 'init',
        state: readJson(STATE_PATH),
        config: readJson(CONFIG_PATH),
        configPath: CONFIG_PATH,
        home: os.homedir(),
        platform: process.platform,
        gpu: useGpu,
      });
      break;
    case 'spawn': spawn(m); break;
    case 'input': { const p = ptys.get(m.id); if (p) p.write(String(m.data || '')); break; }
    case 'resize': {
      const p = ptys.get(m.id);
      if (p) try { p.resize(clamp(m.cols, 80), clamp(m.rows, 24)); } catch {}
      break;
    }
    case 'kill': kill(m.id); break;
    case 'save': writeAtomic(STATE_PATH, JSON.stringify(m.state || {}, null, 2)); break;
    case 'clip-set': if (m.text) clipboard.writeText(String(m.text)); break;
    case 'clip-get': send({ type: 'clip', id: m.id, text: clipboard.readText() }); break;
    case 'browse':
      dialog.showOpenDialog(win, {
        title: 'Working folder for this group',
        defaultPath: m.start && fs.existsSync(m.start) ? m.start : os.homedir(),
        properties: ['openDirectory', 'createDirectory'],
      }).then((r) => send({ type: 'browsed', id: m.id, path: r.canceled ? null : r.filePaths[0] }));
      break;
    case 'open-config': shell.openPath(CONFIG_PATH); break;
    case 'flash': if (win && !win.isFocused()) win.flashFrame(true); break;
    case 'log': if (process.env.AGENTMUX_DEBUG) console.log('[ui]', String(m.text)); break;
    case 'notify':
      // desktop notification when the window isn't focused; clicking it opens the pane
      if (process.env.AGENTMUX_DEBUG) console.log('[notify]', { focused: win && win.isFocused(), supported: Notification.isSupported(), title: m.title });
      if (win && !win.isFocused() && Notification.isSupported()) {
        const n = new Notification({ title: String(m.title || 'AgentMux'), body: String(m.body || ''), urgency: 'critical' });
        n.on('click', () => showPane(m.id));
        n.show();
        notes.add(n); // keep a reference, or the click handler can be garbage-collected
        n.on('close', () => notes.delete(n));
        if (notes.size > 20) notes.delete(notes.values().next().value);
      }
      if (win && !win.isFocused()) win.flashFrame(true);
      break;
  }
}

// ------------------------------------------------------------------ window

function createWindow() {
  const saved = readJson(WINDOW_PATH) || {};
  win = new BrowserWindow({
    width: saved.w || 1500,
    height: saved.h || 900,
    x: Number.isFinite(saved.x) ? saved.x : undefined,
    y: Number.isFinite(saved.y) ? saved.y : undefined,
    title: 'AgentMux',
    backgroundColor: '#0c0c0c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (saved.max) win.maximize();

  win.on('focus', () => win.flashFrame(false));
  win.on('close', (e) => {
    if (!quitting && ptys.size > 0) {
      const r = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'AgentMux',
        message: `${ptys.size} terminal session(s) are still running and will be closed.`,
        detail: 'Quit AgentMux?',
      });
      if (r !== 0) { e.preventDefault(); return; }
    }
    quitting = true;
    try {
      const b = win.getNormalBounds();
      fs.writeFileSync(WINDOW_PATH, JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height, max: win.isMaximized() }));
    } catch {}
  });
  win.on('closed', () => { win = null; });

  // never navigate away from the app page (e.g. a dropped file or link)
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, 'wwwroot', 'index.html'));
}

// No application menu: Electron's default one grabs Ctrl+R / Ctrl+W / Ctrl+Shift+R etc.
Menu.setApplicationMenu(null);

if (!app.requestSingleInstanceLock() && !process.env.AGENTMUX_DATA) {
  app.quit();
} else {
  if (IS_WIN) app.setAppUserModelId('local.agentmux'); // needed for Windows toast notifications
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  startHookServer();
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => { killAll(); app.quit(); });
  app.on('before-quit', () => { quitting = true; });
  process.on('exit', killAll);
}
