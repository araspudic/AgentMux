'use strict';
// AgentMux UI (Linux build). Host = Electron preload (window.agentmuxHost).

const host = window.agentmuxHost || (window.chrome && window.chrome.webview);
const send = (m) => host && host.postMessage(m);

// ======================================================================= helpers
const $ = (s) => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10);
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

const THEME = {
  background: '#0c0c0c', foreground: '#c8c8c8', cursor: '#c8c8c8', cursorAccent: '#0c0c0c',
  selectionBackground: '#264f78',
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
  blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543',
  brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5',
};

// ======================================================================= layout trees
// node = { t:'pane', id, profile, name?, session? } | { t:'split', dir:'row'|'col', sizes:[n..], kids:[node..] }
const R = (...k) => ({ t: 'split', dir: 'row', sizes: k.map(() => 1), kids: k });
const C = (...k) => ({ t: 'split', dir: 'col', sizes: k.map(() => 1), kids: k });

const PRESETS = [
  { key: '1',   label: '1',     tip: 'Single terminal',               build: (s) => s() },
  { key: '2',   label: '1|1',   tip: 'Two side by side',              build: (s) => R(s(), s()) },
  { key: '3',   label: '1|1|1', tip: 'Three side by side',            build: (s) => R(s(), s(), s()) },
  { key: '1+2', label: '1|2',   tip: 'One left, two stacked right',   build: (s) => R(s(), C(s(), s())) },
  { key: '2+1', label: '2|1',   tip: 'Two stacked left, one right',   build: (s) => R(C(s(), s()), s()) },
  { key: '1+3', label: '1|3',   tip: 'One left, three stacked right', build: (s) => R(s(), C(s(), s(), s())) },
  { key: '2x2', label: '2x2',   tip: 'Grid of four',                  build: (s) => R(C(s(), s()), C(s(), s())) },
  { key: 'v2',  label: '1/1',   tip: 'Two stacked (top / bottom)',    build: (s) => C(s(), s()) },
];

function leaves(n, out = []) {
  if (!n) return out;
  if (n.t === 'pane') out.push(n);
  else n.kids.forEach((k) => leaves(k, out));
  return out;
}
function findParent(root, id, parent = null) {
  if (!root) return null;
  if (root.t === 'pane') return root.id === id ? { node: root, parent } : null;
  for (const k of root.kids) { const r = findParent(k, id, root); if (r) return r; }
  return null;
}
function replaceIn(tree, target, nu) {
  if (tree === target) return nu;
  if (tree.t === 'split') tree.kids = tree.kids.map((k) => replaceIn(k, target, nu));
  return tree;
}
// collapse single-child splits, flatten same-direction nesting, drop empties
function normalize(n) {
  if (!n || n.t === 'pane') return n;
  const kids = [], sizes = [];
  n.kids.forEach((k, i) => {
    k = normalize(k);
    if (!k) return;
    const s = n.sizes[i] > 0 ? n.sizes[i] : 1;
    if (k.t === 'split' && k.dir === n.dir) {
      const tot = k.sizes.reduce((a, b) => a + b, 0) || 1;
      k.kids.forEach((kk, j) => { kids.push(kk); sizes.push((s * k.sizes[j]) / tot); });
    } else { kids.push(k); sizes.push(s); }
  });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];
  n.kids = kids; n.sizes = sizes;
  return n;
}
function sanitize(n) {
  if (!n || typeof n !== 'object') return null;
  if (n.t === 'pane') {
    const p = { t: 'pane', id: String(n.id || uid()), profile: String(n.profile || '') };
    if (n.name) p.name = String(n.name);
    if (n.session) p.session = String(n.session);
    if (n.full) p.full = true; // old per-pane fullscreen flag; migrated to g.solo in init()
    return p;
  }
  if (n.t === 'split' && Array.isArray(n.kids)) {
    const kids = n.kids.map(sanitize);
    const sizes = kids.map((_, i) => (Array.isArray(n.sizes) && n.sizes[i] > 0 ? +n.sizes[i] : 1));
    return normalize({ t: 'split', dir: n.dir === 'col' ? 'col' : 'row', sizes, kids });
  }
  return null;
}

// ======================================================================= state
let config = { profiles: [] };
let profiles = [];
let fontSize = 13;
let homeDir = '';
let useGpu = false;
let groups = [];               // persisted model (+ .view element)
let activeGroupId = null;
const panes = new Map();       // runtime pane objects by id

const groupById = (id) => groups.find((g) => g.id === id);
const activeGroup = () => groupById(activeGroupId);
const profileOf = (name) => profiles.find((p) => p.name === name) || profiles[0];
const defaultProfileFor = (g) => (g && g.defaultProfile) || config.defaultProfile || profiles[0].name;
// A group = a split layout (g.layout) + fullscreen panes that live outside it (g.solo).
// g.zoomed = id of the fullscreen pane being shown, or null when the split layout is shown.
const groupNodes = (g) => [...leaves(g.layout), ...g.solo];
const groupPanes = (g) => groupNodes(g).map((n) => panes.get(n.id)).filter(Boolean);
const isSolo = (g, id) => g.solo.some((n) => n.id === id);
const focusedPane = () => { const g = activeGroup(); return g && panes.get(g.focusedPaneId); };

function agentKind(profileName) {
  const c = (profileOf(profileName) || {}).command || '';
  return /(^|[\s;&|(])claude(\s|;|$)/.test(c) ? 'claude' : /(^|[\s;&|(])copilot(\s|;|$)/.test(c) ? 'copilot' : null;
}

let saveTimer = 0;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }
function save() {
  send({
    type: 'save',
    state: {
      version: 2, activeGroupId, fontSize,
      sidebar: !document.body.classList.contains('no-sidebar'),
      groups: groups.map((g) => ({
        id: g.id, name: g.name, cwd: g.cwd, defaultProfile: g.defaultProfile,
        focusedPaneId: g.focusedPaneId, layout: g.layout, solo: g.solo,
      })),
    },
  });
}

// ======================================================================= host messages
const pendingBrowse = new Map();

host && host.addEventListener('message', (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'init': init(m); break;
    case 'out':
      for (const id in m.d) { const p = panes.get(id); if (p) onOutput(p, m.d[id]); }
      break;
    case 'exit': onExit(m.id, m.code); break;
    case 'spawn-error': {
      const p = panes.get(m.id);
      if (p) {
        p.alive = false;
        p.term.write(`\r\n\x1b[31m${m.message}\x1b[0m\r\n\x1b[90m[edit the profile command via config — press Enter to retry]\x1b[0m\r\n`);
        updateGlyphs(p);
      }
      break;
    }
    case 'agent': { const p = panes.get(m.id); if (p) onAgentEvent(p, m.event, m.info || {}); break; }
    case 'open-pane': openPane(m.id); break;
    case 'clip': { const p = panes.get(m.id); if (p && m.text) p.term.paste(m.text); break; }
    case 'browsed': { const cb = pendingBrowse.get(m.id); pendingBrowse.delete(m.id); cb && cb(m.path); break; }
  }
});

function init(m) {
  config = m.config || {};
  profiles = Array.isArray(config.profiles) && config.profiles.length
    ? config.profiles : [{ name: 'Shell', command: 'exec "$SHELL" -l' }];
  homeDir = m.home || '';
  useGpu = !!m.gpu;
  const st = m.state || {};
  fontSize = st.fontSize || config.fontSize || 13;
  if (st.sidebar === false) document.body.classList.add('no-sidebar');

  for (const sg of st.groups || []) {
    const g = {
      id: String(sg.id || uid()), name: String(sg.name || 'group'), cwd: sg.cwd || '',
      defaultProfile: sg.defaultProfile || '', focusedPaneId: sg.focusedPaneId || null,
      layout: sanitize(sg.layout), zoomed: null,
      solo: (Array.isArray(sg.solo) ? sg.solo : []).map(sanitize).filter((n) => n && n.t === 'pane'),
    };
    for (const n of leaves(g.layout)) {
      if (sg.full || n.full) { removeFromLayout(g, n.id); g.solo.push(n); }
    }
    for (const n of g.solo) delete n.full;
    if (isSolo(g, g.focusedPaneId)) g.zoomed = g.focusedPaneId;
    addGroupView(g);
    groups.push(g);
    // restored Claude panes resume their previous conversation (if we know its session id)
    for (const n of groupNodes(g)) createPane(n, g).resumeOnStart = true;
    renderLayout(g);
  }
  buildToolbar();
  activateGroup(groupById(st.activeGroupId) ? st.activeGroupId : groups[0] && groups[0].id);
  if (!groups.length) openGroupDialog();
}

// ======================================================================= panes
function paneName(p) { return p.node.name || p.node.profile; }
function label(p) {
  const t = (p.title || '').replace(/^[^\w]+\s*/, '');
  return p.title && t.toLowerCase() !== paneName(p).toLowerCase() ? `${paneName(p)} — ${p.title}` : paneName(p);
}
function newPaneNode(profile) {
  return { t: 'pane', id: uid(), profile: profile || profiles[0].name };
}

function createPane(node, g) {
  if (!profiles.some((x) => x.name === node.profile)) node.profile = defaultProfileFor(g);

  const glyph = h('span', { class: 'glyph', text: '○' });
  const name = h('span', { class: 'pane-name', title: 'Double-click to rename' });
  const title = h('span', { class: 'pane-title' });
  const sel = h('select', { class: 'pane-profile', title: 'Profile — changing it restarts this pane' });
  for (const pr of profiles) sel.append(h('option', { value: pr.name, text: pr.name }));
  sel.value = node.profile;

  const btn = (txt, tip, fn) => h('button', {
    class: 'pbtn', title: tip, text: txt,
    onmousedown: (e) => e.preventDefault(),
    onclick: (e) => { e.stopPropagation(); fn(); },
  });
  const zoomBtn = btn('□', 'Fullscreen (Ctrl+Shift+Z)', () => toggleZoom(node.id));
  const forkBtn = btn('Y', 'Fork this Claude session (Ctrl+Shift+F)', () => forkPane(node.id));
  const head = h('div', { class: 'pane-head' }, glyph, name, title, sel,
    btn('│', 'Split right (Ctrl+Shift+D)', () => splitPane(node.id, 'row')),
    btn('─', 'Split down (Ctrl+Shift+E)', () => splitPane(node.id, 'col')),
    zoomBtn, forkBtn,
    btn('↻', 'Restart — new session (Ctrl+Shift+R)', () => restartPane(node.id)),
    btn('✕', 'Close (Ctrl+Shift+W)', () => closePane(node.id)));
  const body = h('div', { class: 'pane-body' });
  const el = h('div', { class: 'pane' }, head, body);

  const term = new Terminal({
    fontFamily: config.fontFamily || "'DejaVu Sans Mono', monospace", fontSize,
    scrollback: config.scrollback || 10000, cursorBlink: !!config.cursorBlink,
    allowProposedApi: true, theme: THEME,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  try { term.loadAddon(new Unicode11Addon.Unicode11Addon()); term.unicode.activeVersion = '11'; } catch {}

  const p = {
    id: node.id, node, groupId: g.id, term, fit, el, body, glyph, nameEl: name, titleEl: title, sel, zoomBtn, forkBtn,
    opened: false, started: false, alive: false, title: '', kind: null,
    agent: 'idle', askMsg: null, hooked: false, answeredRow: -1,
    lastOut: 0, lastInput: 0, burstStart: 0, burstLast: 0, quietT: 0,
    sideGlyph: null, fitQueued: false, startCmd: null, resumeOnStart: false,
  };
  panes.set(node.id, p);
  forkBtn.disabled = !profileOf(node.profile).fork;

  name.addEventListener('dblclick', () => renamePane(p.id));
  sel.addEventListener('change', () => {
    if (p.alive && !confirm(`Restart this pane as "${sel.value}"? The running process will be killed.`)) {
      sel.value = node.profile; return;
    }
    node.profile = sel.value;
    p.title = '';
    forkBtn.disabled = !profileOf(node.profile).fork;
    restartPane(node.id);
    saveSoon();
  });

  term.onData((d) => {
    p.lastInput = Date.now();
    if (p.alive) send({ type: 'input', id: p.id, data: d });
    else if (p.started && d === '\r') { restartPane(p.id); return; }
    onUserInput(p, d);
  });
  term.onBinary((d) => p.alive && send({ type: 'input', id: p.id, data: d }));
  term.onResize(({ cols, rows }) => p.alive && send({ type: 'resize', id: p.id, cols, rows }));
  term.onTitleChange((t) => {
    t = (t || '').trim();
    if (t === p.title) return;
    p.title = t;
    updatePaneHeader(p);
    renderSidebarSoon();
  });
  term.onBell(() => {
    if (p.kind && !p.hooked && p.agent === 'working') setAgent(p, 'done');
    else if (!isWatching(p)) send({ type: 'flash' });
  });

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const plainCtrl = e.ctrlKey && !e.shiftKey && !e.altKey;
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
      // Claude Code treats ESC+CR as "insert newline"
      if (p.alive) send({ type: 'input', id: p.id, data: '\x1b\r' });
      e.preventDefault();
      return false;
    }
    if (plainCtrl && e.code === 'KeyC' && term.hasSelection()) { copySelection(p); e.preventDefault(); return false; }
    if (plainCtrl && e.code === 'KeyV') return false; // let the browser fire a paste event (bracketed paste)
    return true;
  });

  body.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) copySelection(p);
    else send({ type: 'clip-get', id: p.id });
  });
  el.addEventListener('mousedown', () => setFocused(p), true);

  p.ro = new ResizeObserver(() => {
    if (!p.opened) { queueRefresh(); return; }
    if (p.fitQueued) return;
    p.fitQueued = true;
    requestAnimationFrame(() => { p.fitQueued = false; fitPane(p); });
  });
  p.ro.observe(body);

  updatePaneHeader(p);
  updateGlyphs(p);
  return p;
}

function openTerm(p) {
  p.term.open(p.body);
  if (useGpu) {
    try {
      const gl = new WebglAddon.WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      p.term.loadAddon(gl);
    } catch {}
  }
  p.term.textarea && p.term.textarea.addEventListener('focus', () => setFocused(p));
  p.opened = true;
}

function fitPane(p) {
  if (!p.opened || !p.el.isConnected || p.body.clientWidth < 20 || p.body.clientHeight < 20) return;
  try { p.fit.fit(); } catch {}
}

function spawn(p) {
  const g = groupById(p.groupId);
  const prof = profileOf(p.node.profile);
  let command = prof.command;
  if (p.startCmd) command = p.startCmd;
  else if (p.resumeOnStart && p.node.session && prof.resume) command = prof.resume.replace(/\{session\}/g, p.node.session);
  p.startCmd = null;
  p.resumeOnStart = false;
  p.kind = agentKind(p.node.profile);
  p.started = true; p.alive = true; p.hooked = false;
  p.lastOut = 0; p.burstStart = 0; p.answeredRow = -1;
  setAgent(p, 'idle');
  send({ type: 'spawn', id: p.id, command, cwd: (g && g.cwd) || '', cols: p.term.cols, rows: p.term.rows });
  updateGlyphs(p);
  updatePaneHeader(p);
}

function restartPane(id) {
  const p = panes.get(id);
  if (!p) return;
  if (p.alive) send({ type: 'kill', id });
  p.alive = false;
  delete p.node.session; // restart = a fresh session
  p.term.reset();
  if (p.opened) { fitPane(p); spawn(p); } else p.started = false;
  p.term.focus();
  saveSoon();
}

function onExit(id, code) {
  const p = panes.get(id);
  if (!p) return;
  p.alive = false;
  p.term.write(`\r\n\x1b[90m[process exited with code ${code} — press Enter to restart]\x1b[0m\r\n`);
  setAgent(p, 'idle');
  updateGlyphs(p);
  renderSidebarSoon();
}

function copySelection(p) {
  const text = p.term.getSelection();
  if (text) send({ type: 'clip-set', text });
  p.term.clearSelection();
}

function isWatching(p) {
  const g = activeGroup();
  return document.hasFocus() && g && g.id === p.groupId && g.focusedPaneId === p.id;
}

// ======================================================================= agent state
// p.agent: 'idle' | 'working' | 'ask' (needs your answer) | 'done' (finished your request)
// Claude panes report exactly via hooks (see main.js). Other agents (Copilot) are inferred from
// output activity and from what the screen shows when the output stops.

const QUESTION_RE = /(do you want to[^\n]*|would you like to[^\n]*\?|allow [^\n]*\?|approve [^\n]*\?|\((?:y\/n|y\/N|Y\/n)\)|\[(?:y\/n|y\/N|Y\/n)\]|❯\s*1\.\s*(?:yes|allow|approve)[^\n]*)/i;

function onOutput(p, data) {
  p.term.write(data);
  const now = Date.now();
  p.lastOut = now;
  if (!p.kind || p.hooked) return;
  if (now - p.lastInput < 400) return; // echo of what you typed
  if (!p.burstStart || now - p.burstLast > 1500) p.burstStart = now;
  p.burstLast = now;
  if (p.agent !== 'working' && p.agent !== 'ask' && now - p.burstStart > 1200) setAgent(p, 'working');
  clearTimeout(p.quietT);
  p.quietT = setTimeout(() => onQuiet(p), 1500);
}

// output stopped (non-hooked agents): a question on screen -> ask; long busy period -> done
function onQuiet(p) {
  if (p.hooked || !p.alive) return;
  const q = findQuestion(p);
  if (q) setAgent(p, 'ask', q);
  else if (p.agent === 'working') setAgent(p, p.burstLast - p.burstStart > 3000 ? 'done' : 'idle');
  p.burstStart = 0;
}

function findQuestion(p) {
  const b = p.term.buffer.active;
  const cur = b.baseY + b.cursorY;
  const from = Math.max(cur - 12, p.answeredRow + 1, 0);
  const lines = [];
  for (let i = from; i <= Math.min(b.length - 1, cur + 2); i++) {
    const l = b.getLine(i);
    lines.push(l ? l.translateToString(true) : '');
  }
  const m = lines.join('\n').match(QUESTION_RE);
  return m ? m[0].replace(/\s+/g, ' ').trim().slice(0, 140) : null;
}

function onUserInput(p, d) {
  if (!p.kind) return;
  if (d.includes('\r')) {
    if (p.agent === 'ask') {
      const b = p.term.buffer.active;
      p.answeredRow = b.baseY + b.cursorY; // don't re-detect the question we just answered
      setAgent(p, 'working');
    } else if (p.agent === 'done') setAgent(p, 'idle');
  } else if (d === '\x1b' && p.agent === 'ask') {
    setAgent(p, 'idle');
  }
}

function onAgentEvent(p, ev, info) {
  p.hooked = true;
  if (info.session && info.session !== p.node.session) { p.node.session = info.session; saveSoon(); }
  switch (ev) {
    case 'prompt': setAgent(p, 'working'); break;
    case 'ask-tool':
      setAgent(p, 'ask', info.tool === 'ExitPlanMode' ? 'Claude wants you to approve its plan' : 'Claude has a question for you');
      break;
    case 'tool-done': if (p.agent === 'ask' || p.agent === 'idle') setAgent(p, 'working'); break;
    case 'notify':
      if (info.kind === 'idle_prompt' || /waiting for your input/i.test(info.message || '')) {
        if (p.agent === 'working') setAgent(p, 'done');
      } else if (info.kind !== 'auth_success') {
        setAgent(p, 'ask', info.message || 'Claude needs your input');
      }
      break;
    case 'stop': setAgent(p, 'done'); break;
  }
  updateForkButtons();
}

function setAgent(p, state, msg) {
  msg = state === 'ask' ? (msg || 'needs your input') : null;
  if (p.agent === state && p.askMsg === msg) return;
  const prev = p.agent;
  p.agent = state;
  p.askMsg = msg;
  if (state === 'ask') {
    if (!isWatching(p)) {
      showToast(p);
      const g = groupById(p.groupId);
      send({ type: 'notify', id: p.id, title: `${g ? g.name : ''} › ${paneName(p)} needs your input`, body: msg });
    }
  } else {
    removeToast(p.id);
    if (state === 'done' && prev === 'working' && !isWatching(p)) send({ type: 'flash' });
  }
  p.el.classList.toggle('st-ask', state === 'ask');
  p.el.classList.toggle('st-done', state === 'done');
  updateGlyphs(p);
  renderSidebarSoon();
}

const SPIN = ['|', '/', '-', '\\'];
let spinFrame = 0;

function glyphOf(p) {
  if (!p.started) return ['○', ''];
  if (!p.alive) return ['x', 'g-dead'];
  if (p.kind) {
    if (p.agent === 'ask') return ['!', 'g-ask'];
    if (p.agent === 'working') return [SPIN[spinFrame % 4], 'g-working'];
    if (p.agent === 'done') return ['✓', 'g-done'];
    return ['·', ''];
  }
  return Date.now() - p.lastOut < 2000 ? ['•', 'g-live'] : ['·', ''];
}

function updateGlyphs(p) {
  const [t, c] = glyphOf(p);
  const cls = 'glyph ' + c;
  for (const el of [p.glyph, p.sideGlyph]) {
    if (!el) continue;
    if (el.textContent !== t) el.textContent = t;
    if (el.className !== cls) el.className = cls;
  }
}

// spinner + shell activity: one cheap timer that only touches the glyph text
setInterval(() => {
  spinFrame++;
  for (const p of panes.values()) {
    if ((p.kind && p.agent === 'working') || (!p.kind && p.alive)) updateGlyphs(p);
  }
}, 150);

// ---------------------------------------------------------------- toasts (bottom right)
const toasts = new Map();

function showToast(p) {
  removeToast(p.id);
  const g = groupById(p.groupId);
  const el = h('div', { class: 'toast', title: 'Click to open this pane', onclick: () => openPane(p.id) },
    h('span', { class: 't-mark', text: '!' }),
    h('div', { class: 't-body' },
      h('div', { class: 't-where', text: `${g ? g.name : ''} › ${paneName(p)}` }),
      h('div', { class: 't-msg', text: p.askMsg || 'needs your input' })),
    h('button', { class: 't-close', text: 'x', title: 'Dismiss', onclick: (e) => { e.stopPropagation(); removeToast(p.id); } }));
  $('#toasts').append(el);
  toasts.set(p.id, el);
}
function removeToast(id) {
  const el = toasts.get(id);
  if (el) { el.remove(); toasts.delete(id); }
}

function openPane(id) {
  const p = panes.get(id);
  if (!p) return;
  if (activeGroupId !== p.groupId) activateGroup(p.groupId);
  focusPane(id);
  removeToast(id);
}

function jumpToAsk() {
  const all = groups.flatMap(groupPanes);
  const cur = all.indexOf(focusedPane());
  for (let k = 1; k <= all.length; k++) {
    const p = all[(cur + k) % all.length];
    if (p && p.agent === 'ask') { openPane(p.id); return; }
  }
}

// ======================================================================= pane ops
function setFocused(p) {
  const g = groupById(p.groupId);
  if (!g) return;
  const changed = g.focusedPaneId !== p.id;
  g.focusedPaneId = p.id;
  if (!isSolo(g, p.id)) g.lastTiledId = p.id;
  removeToast(p.id);
  for (const q of groupPanes(g)) q.el.classList.toggle('focused', q === p);
  if (changed) { renderSidebar(); saveSoon(); updateForkButtons(); }
}

// "Open" a pane: a fullscreen pane is shown alone, a split pane shows the split layout.
function focusPane(id) {
  const p = panes.get(id);
  if (!p) return;
  const g = groupById(p.groupId);
  const want = isSolo(g, p.id) ? p.id : null;
  if (g.zoomed !== want) { g.zoomed = want; renderLayout(g); }
  setFocused(p);
  if (p.opened) p.term.focus(); else p.focusOnOpen = true;
}

function removeFromLayout(g, id) {
  const r = findParent(g.layout, id);
  if (!r) return;
  if (!r.parent) g.layout = null;
  else {
    const i = r.parent.kids.indexOf(r.node);
    r.parent.kids.splice(i, 1);
    r.parent.sizes.splice(i, 1);
  }
  g.layout = normalize(g.layout);
}

function autoDir(g, target) {
  if (target.el.isConnected) {
    const r = target.el.getBoundingClientRect();
    if (r.width > 0) return r.width > r.height * 1.6 ? 'row' : 'col';
  }
  const r = findParent(g.layout, target.id);
  return r && r.parent && r.parent.dir === 'row' ? 'col' : 'row';
}

// put a node into the split layout, next to nearId (or the last used split pane)
function insertIntoLayout(g, node, nearId) {
  if (!g.layout) { g.layout = node; return; }
  const ids = leaves(g.layout).map((n) => n.id);
  if (!ids.includes(nearId)) nearId = ids.includes(g.lastTiledId) ? g.lastTiledId : ids[ids.length - 1];
  const near = panes.get(nearId);
  const dir = autoDir(g, near);
  const { parent } = findParent(g.layout, nearId);
  if (parent && parent.dir === dir) {
    const i = parent.kids.indexOf(near.node);
    const s = parent.sizes[i] / 2;
    parent.sizes[i] = s;
    parent.kids.splice(i + 1, 0, node);
    parent.sizes.splice(i + 1, 0, s);
  } else {
    const split = { t: 'split', dir, sizes: [1, 1], kids: [near.node, node] };
    if (!parent) g.layout = split;
    else parent.kids[parent.kids.indexOf(near.node)] = split;
  }
}

// Explicit split (│ / ─ / Ctrl+Shift+D/E). Splitting a fullscreen pane moves it into the split layout first.
function splitPane(id, dir, profile) {
  const p = panes.get(id);
  if (!p) return;
  const g = groupById(p.groupId);
  if (isSolo(g, id)) {
    g.solo = g.solo.filter((n) => n.id !== id);
    insertIntoLayout(g, p.node);
  }
  const node = newPaneNode(profile || p.node.profile);
  const { parent } = findParent(g.layout, id);
  if (parent && parent.dir === dir) {
    const i = parent.kids.indexOf(p.node);
    const s = parent.sizes[i] / 2;
    parent.sizes[i] = s;
    parent.kids.splice(i + 1, 0, node);
    parent.sizes.splice(i + 1, 0, s);
  } else {
    const split = { t: 'split', dir, sizes: [1, 1], kids: [p.node, node] };
    if (!parent) g.layout = split;
    else parent.kids[parent.kids.indexOf(p.node)] = split;
  }
  g.zoomed = null;
  createPane(node, g).focusOnOpen = true;
  g.focusedPaneId = node.id;
  renderLayout(g);
  renderSidebar();
  saveSoon();
}

// New pane next to `near` (default: focused pane): while looking at a fullscreen pane it becomes another
// fullscreen pane; while looking at the split layout it joins the split.
function placeNewPane(g, node, near) {
  if (g.zoomed) {
    g.solo.push(node);
    g.zoomed = node.id;
  } else {
    insertIntoLayout(g, node, near && !isSolo(g, near.id) ? near.id : null);
  }
  const np = createPane(node, g);
  np.focusOnOpen = true;
  g.focusedPaneId = node.id;
  renderLayout(g);
  renderSidebar();
  saveSoon();
  return np;
}

function addPane(profile) {
  const g = activeGroup();
  if (!g) { openGroupDialog(); return; }
  placeNewPane(g, newPaneNode(profile || defaultProfileFor(g)), focusedPane());
}

async function forkPane(id) {
  const p = panes.get(id || (focusedPane() || {}).id);
  if (!p) return;
  const prof = profileOf(p.node.profile);
  if (!prof.fork) {
    alert(`"${prof.name}" panes can't be forked: its profile has no "fork" command.\n(Forking works for Claude sessions.)`);
    return;
  }
  if (!p.node.session) {
    alert('AgentMux doesn\'t know this Claude session\'s id yet.\nWait until Claude has started in this pane, then try again.');
    return;
  }
  const name = await askText({
    title: 'fork session',
    info: `from: ${label(p)}\nsession: ${p.node.session}`,
    label: 'name of the new fork',
    value: `${paneName(p)} fork`,
  });
  if (!name) return;
  const g = groupById(p.groupId);
  const node = newPaneNode(p.node.profile);
  node.name = name;
  const np = placeNewPane(g, node, p);
  np.startCmd = prof.fork.replace(/\{session\}/g, p.node.session);
}

function updateForkButtons() {
  const fp = focusedPane();
  const can = (p) => !!(p && profileOf(p.node.profile).fork && p.node.session);
  $('#tb-fork').disabled = !can(fp);
  for (const p of panes.values()) p.forkBtn.disabled = !profileOf(p.node.profile).fork;
}

async function renamePane(id) {
  const p = panes.get(id);
  if (!p) return;
  const n = await askText({ title: 'rename pane', label: 'name (empty = profile name)', value: p.node.name || '' });
  if (n === null) return;
  if (n) p.node.name = n; else delete p.node.name;
  updatePaneHeader(p);
  renderSidebar();
  saveSoon();
}

function closePane(id, ask = true) {
  const p = panes.get(id);
  if (!p) return;
  const g = groupById(p.groupId);
  if (ask && p.alive && !confirm(`Close "${label(p)}"?\nThe running process will be killed.`)) return;
  destroyPane(p);
  removeFromLayout(g, id);
  g.solo = g.solo.filter((n) => n.id !== id);
  if (g.zoomed === id) g.zoomed = null;
  if (g.focusedPaneId === id) {
    const next = leaves(g.layout).find((n) => n.id === g.lastTiledId) || leaves(g.layout)[0] || g.solo[0];
    g.focusedPaneId = next ? next.id : null;
  }
  renderLayout(g);
  if (g.focusedPaneId) focusPane(g.focusedPaneId);
  renderSidebar();
  saveSoon();
}

function destroyPane(p) {
  if (p.alive) send({ type: 'kill', id: p.id });
  p.alive = false;
  clearTimeout(p.quietT);
  removeToast(p.id);
  p.ro.disconnect();
  try { p.term.dispose(); } catch {}
  p.el.remove();
  panes.delete(p.id);
}

function toggleZoom(id) {
  const p = panes.get(id || (focusedPane() || {}).id);
  if (!p) return;
  const g = groupById(p.groupId);
  if (isSolo(g, p.id)) {
    g.solo = g.solo.filter((n) => n.id !== p.id);
    insertIntoLayout(g, p.node);
  } else {
    removeFromLayout(g, p.id);
    g.solo.push(p.node);
  }
  focusPane(p.id);
  renderLayout(g);
  renderSidebar();
  saveSoon();
}

function applyPreset(g, preset, profile) {
  const existing = leaves(g.layout);
  let i = 0;
  const created = [];
  const slot = () => {
    if (i < existing.length) return existing[i++];
    const n = newPaneNode(profile || defaultProfileFor(g));
    created.push(n);
    return n;
  };
  let tree = preset.build(slot);
  const extra = existing.slice(i);
  if (extra.length) {
    const ls = leaves(tree);
    const last = ls[ls.length - 1];
    tree = replaceIn(tree, last, C(last, ...extra));
  }
  g.layout = normalize(tree);
  g.zoomed = null;
  for (const n of created) createPane(n, g);
  if (!g.focusedPaneId || !panes.has(g.focusedPaneId) || isSolo(g, g.focusedPaneId)) g.focusedPaneId = leaves(g.layout)[0].id;
  renderLayout(g);
  renderSidebar();
  saveSoon();
}

function moveFocus(dir) {
  const cur = focusedPane();
  const g = activeGroup();
  if (!cur || !g) return;
  const cycle = () => {
    const ps = groupPanes(g);
    const i = ps.indexOf(cur) + (dir === 'left' || dir === 'up' ? -1 : 1);
    focusPane(ps[(i + ps.length) % ps.length].id);
  };
  if (g.zoomed) { cycle(); return; }
  const a = cur.el.getBoundingClientRect();
  const acx = (a.left + a.right) / 2, acy = (a.top + a.bottom) / 2;
  let best = null, bestScore = Infinity;
  for (const p of groupPanes(g)) {
    if (p === cur || !p.el.isConnected) continue;
    const b = p.el.getBoundingClientRect();
    const bcx = (b.left + b.right) / 2, bcy = (b.top + b.bottom) / 2;
    let primary, secondary;
    if (dir === 'left')  { if (b.right > a.left + 2) continue;  primary = a.left - b.right;  secondary = Math.abs(bcy - acy); }
    if (dir === 'right') { if (b.left < a.right - 2) continue;  primary = b.left - a.right;  secondary = Math.abs(bcy - acy); }
    if (dir === 'up')    { if (b.bottom > a.top + 2) continue;  primary = a.top - b.bottom;  secondary = Math.abs(bcx - acx); }
    if (dir === 'down')  { if (b.top < a.bottom - 2) continue;  primary = b.top - a.bottom;  secondary = Math.abs(bcx - acx); }
    const score = primary * 2 + secondary;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  if (best) focusPane(best.id);
  else if (g.solo.length) cycle();
}

function setFontSize(n) {
  fontSize = Math.max(8, Math.min(32, n));
  for (const p of panes.values()) { p.term.options.fontSize = fontSize; fitPane(p); }
  saveSoon();
}

// ======================================================================= rendering
function addGroupView(g) {
  g.view = h('div', { class: 'group-view' });
  $('#views').append(g.view);
}

function updatePaneHeader(p) {
  p.nameEl.textContent = paneName(p);
  const t = (p.title || '').replace(/^[^\w]+\s*/, '');
  p.titleEl.textContent = p.title && t.toLowerCase() !== paneName(p).toLowerCase() ? p.title : '';
  p.titleEl.title = label(p);
}

function renderLayout(g) {
  const view = g.view;
  view.replaceChildren();
  for (const p of groupPanes(g)) {
    const solo = isSolo(g, p.id);
    p.el.classList.toggle('focused', p.id === g.focusedPaneId);
    p.zoomBtn.classList.toggle('on', solo);
    p.zoomBtn.textContent = solo ? '■' : '□';
    p.zoomBtn.title = solo ? 'Exit fullscreen — put back into the split layout (Ctrl+Shift+Z)'
                           : 'Fullscreen — take this pane out of the split (Ctrl+Shift+Z)';
  }
  const zp = g.zoomed && panes.get(g.zoomed);
  if (!zp && !g.layout) {
    view.append(h('div', { class: 'empty', text: g.solo.length
      ? 'all terminals in this group are fullscreen — pick one in the sidebar'
      : 'no terminals — add one from the toolbar (Ctrl+Shift+T)' }));
    return;
  }
  const root = zp ? zp.el : build(g.layout);
  root.style.flex = '1 1 0px';
  view.append(root);
  queueRefresh();
}

function build(node) {
  if (node.t === 'pane') return panes.get(node.id).el;
  const box = h('div', { class: 'split ' + node.dir });
  node.kids.forEach((k, i) => {
    if (i) box.append(gutter(node, i - 1, box));
    const c = build(k);
    c.style.flex = `${node.sizes[i]} 1 0px`;
    box.append(c);
  });
  return box;
}

function gutter(node, i, box) {
  const el = h('div', { class: 'gutter ' + node.dir, title: 'Drag to resize, double-click to equalize' });
  el.addEventListener('dblclick', () => {
    node.sizes = node.sizes.map(() => 1);
    const g = activeGroup();
    if (g) renderLayout(g);
    saveSoon();
  });
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const horiz = node.dir === 'row';
    const kids = [...box.children].filter((c) => !c.classList.contains('gutter'));
    const a = kids[i], b = kids[i + 1];
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const pa = horiz ? ra.width : ra.height, pb = horiz ? rb.width : rb.height;
    const total = node.sizes[i] + node.sizes[i + 1];
    const start = horiz ? e.clientX : e.clientY;
    const overlay = h('div', { class: 'drag-overlay ' + node.dir });
    document.body.append(overlay);
    const move = (ev) => {
      const d = (horiz ? ev.clientX : ev.clientY) - start;
      const na = Math.max(60, Math.min(pa + pb - 60, pa + d));
      node.sizes[i] = (total * na) / (pa + pb);
      node.sizes[i + 1] = total - node.sizes[i];
      a.style.flex = `${node.sizes[i]} 1 0px`;
      b.style.flex = `${node.sizes[i + 1]} 1 0px`;
    };
    const up = () => {
      overlay.remove();
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      saveSoon();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  return el;
}

// open / fit / start any visible panes of the active group (lazy start)
let refreshQueued = false;
function queueRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => { refreshQueued = false; refreshVisible(); });
}
function refreshVisible() {
  const g = activeGroup();
  if (!g) return;
  for (const p of groupPanes(g)) {
    if (!p.el.isConnected || p.body.clientWidth < 20 || p.body.clientHeight < 20) continue;
    if (!p.opened) openTerm(p);
    fitPane(p);
    if (!p.started) spawn(p);
    if (p.focusOnOpen) { p.focusOnOpen = false; p.term.focus(); }
  }
}

function shortPath(s) {
  if (!s) return '';
  if (homeDir && s.startsWith(homeDir)) return '~' + s.slice(homeDir.length);
  return s;
}

let sidebarQueued = false;
function renderSidebarSoon() {
  if (sidebarQueued) return;
  sidebarQueued = true;
  requestAnimationFrame(() => { sidebarQueued = false; renderSidebar(); });
}

function renderSidebar() {
  const list = $('#groups');
  list.replaceChildren();
  for (const g of groups) {
    const ps = groupPanes(g);
    const active = g.id === activeGroupId;
    const asks = ps.filter((p) => p.agent === 'ask').length;
    const head = h('div', {
      class: 'g-head' + (active ? ' active' : '') + (asks ? ' ask' : ''),
      title: (g.cwd || '(home folder)') + '\nDouble-click to rename',
      onclick: () => activateGroup(g.id),
      ondblclick: () => renameGroup(g),
    },
      h('span', { class: 'g-name', text: g.name }),
      h('span', { class: 'g-count', text: asks ? `!${asks}` : String(ps.length) }),
      h('button', { class: 'g-btn', title: 'Close group', text: 'x', onclick: (e) => { e.stopPropagation(); closeGroup(g); } }));
    const box = h('div', { class: 'group' }, head);
    if (g.cwd) box.append(h('div', { class: 'g-cwd', title: g.cwd, text: shortPath(g.cwd) }));
    for (const p of ps) {
      p.sideGlyph = h('span', { class: 'glyph' });
      updateGlyphs(p);
      box.append(h('div', {
        class: 's-item' + (active && g.focusedPaneId === p.id ? ' focused' : '') +
          (p.kind && p.agent === 'ask' ? ' st-ask' : '') + (p.kind && p.agent === 'done' ? ' st-done' : ''),
        title: label(p) + (p.agent === 'ask' && p.askMsg ? `\n! ${p.askMsg}` : '') + '\nDouble-click to rename',
        onclick: () => openPane(p.id),
        ondblclick: () => renamePane(p.id),
      }, p.sideGlyph, h('span', { class: 's-label', text: label(p) }),
        isSolo(g, p.id) ? h('span', { class: 's-full', text: '□', title: 'Fullscreen pane' }) : null));
    }
    list.append(box);
  }
}

function buildToolbar() {
  const lay = $('#tb-layouts');
  lay.replaceChildren();
  for (const pr of PRESETS) {
    lay.append(h('button', {
      text: pr.label, title: pr.tip + ' (arranges the split panes; adds new ones if needed)',
      onmousedown: (e) => e.preventDefault(),
      onclick: () => { const g = activeGroup(); if (g) applyPreset(g, pr); },
    }));
  }
  const add = $('#tb-add');
  add.replaceChildren();
  for (const prof of profiles) {
    add.append(h('button', {
      text: '+' + prof.name.toLowerCase().split(' ')[0], title: `Add a ${prof.name} terminal`,
      onmousedown: (e) => e.preventDefault(),
      onclick: () => addPane(prof.name),
    }));
  }
  updateForkButtons();
}

function updateToolbar() {
  const g = activeGroup();
  $('#tb-title').textContent = g ? `[${g.name}]` : '';
  $('#tb-cwd').textContent = g ? shortPath(g.cwd) : '';
  $('#toolbar').style.visibility = g ? 'visible' : 'hidden';
  $('#welcome').classList.toggle('hidden', groups.length > 0);
  document.title = g ? `AgentMux — ${g.name}` : 'AgentMux';
}

// ======================================================================= groups
function activateGroup(id) {
  activeGroupId = id || null;
  for (const g of groups) g.view.classList.toggle('active', g.id === activeGroupId);
  updateToolbar();
  renderSidebar();
  const g = activeGroup();
  if (g) {
    queueRefresh();
    requestAnimationFrame(() => {
      const p = panes.get(g.focusedPaneId) || groupPanes(g)[0];
      if (p) focusPane(p.id);
    });
  }
  updateForkButtons();
  saveSoon();
}

function cycleGroup(delta) {
  if (!groups.length) return;
  const i = groups.findIndex((g) => g.id === activeGroupId);
  activateGroup(groups[(i + delta + groups.length) % groups.length].id);
}

function createGroup({ name, cwd, profile, presetKey }) {
  const g = { id: uid(), name, cwd, defaultProfile: profile, focusedPaneId: null, layout: null, solo: [], zoomed: null };
  addGroupView(g);
  groups.push(g);
  applyPreset(g, PRESETS.find((p) => p.key === presetKey) || PRESETS[0], profile);
  activateGroup(g.id);
}

async function renameGroup(g) {
  const n = await askText({ title: 'rename group', label: 'name', value: g.name });
  if (n) { g.name = n; renderSidebar(); updateToolbar(); saveSoon(); }
}

function closeGroup(g) {
  const ps = groupPanes(g);
  const running = ps.filter((p) => p.alive).length;
  if (!confirm(`Close group "${g.name}"?` + (running ? `\n${running} running terminal(s) will be killed.` : ''))) return;
  ps.forEach(destroyPane);
  g.view.remove();
  const i = groups.indexOf(g);
  groups.splice(i, 1);
  if (activeGroupId === g.id) activateGroup(groups.length ? groups[Math.min(i, groups.length - 1)].id : null);
  else { renderSidebar(); saveSoon(); }
}

// ======================================================================= dialogs
function showDialog(id) {
  $('#modal').classList.remove('hidden');
  for (const d of document.querySelectorAll('.dialog')) d.classList.toggle('hidden', d.id !== id);
}
function hideDialog() {
  $('#modal').classList.add('hidden');
  if (textResolve) { const r = textResolve; textResolve = null; r(null); }
  const p = focusedPane();
  if (p && p.opened) p.term.focus();
}
const dialogOpen = () => !$('#modal').classList.contains('hidden');
const dialogShown = (id) => dialogOpen() && !$('#' + id).classList.contains('hidden');

// small text-input dialog (Electron has no window.prompt)
let textResolve = null;
function askText({ title, info = '', label: lbl, value = '' }) {
  if (textResolve) { textResolve(null); textResolve = null; }
  $('#tx-title').textContent = title;
  $('#tx-info').textContent = info;
  $('#tx-info').classList.toggle('hidden', !info);
  $('#tx-info').style.whiteSpace = 'pre-line';
  $('#tx-label').textContent = lbl;
  $('#tx-input').value = value;
  showDialog('dlg-text');
  $('#tx-input').focus();
  $('#tx-input').select();
  return new Promise((res) => { textResolve = res; });
}
function submitText() {
  const r = textResolve;
  textResolve = null;
  const v = $('#tx-input').value.trim();
  hideDialog();
  if (r) r(v);
}
$('#tx-ok').addEventListener('click', submitText);
$('#tx-cancel').addEventListener('click', hideDialog);

function openGroupDialog() {
  const prof = $('#ng-profile');
  prof.replaceChildren(...profiles.map((p) => h('option', { value: p.name, text: p.name })));
  prof.value = config.defaultProfile && profiles.some((p) => p.name === config.defaultProfile) ? config.defaultProfile : profiles[0].name;
  const lay = $('#ng-layout');
  lay.replaceChildren(...PRESETS.map((p) => h('option', { value: p.key, text: `${p.label}  —  ${p.tip}` })));
  lay.value = '1';
  $('#ng-name').value = '';
  $('#ng-cwd').value = '';
  showDialog('dlg-group');
  $('#ng-name').focus();
}

function baseName(p) {
  const parts = (p || '').replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

$('#ng-browse').addEventListener('click', () => {
  const id = uid();
  pendingBrowse.set(id, (path) => {
    if (!path) return;
    $('#ng-cwd').value = path;
    if (!$('#ng-name').value.trim()) $('#ng-name').value = baseName(path);
  });
  send({ type: 'browse', id, start: $('#ng-cwd').value.trim() });
});
$('#ng-cwd').addEventListener('change', () => {
  if (!$('#ng-name').value.trim()) $('#ng-name').value = baseName($('#ng-cwd').value.trim());
});
function submitGroupDialog() {
  const cwd = $('#ng-cwd').value.trim().replace(/^"(.*)"$/, '$1');
  const name = $('#ng-name').value.trim() || baseName(cwd) || `group ${groups.length + 1}`;
  hideDialog();
  createGroup({ name, cwd, profile: $('#ng-profile').value, presetKey: $('#ng-layout').value });
}
$('#ng-ok').addEventListener('click', submitGroupDialog);
$('#ng-cancel').addEventListener('click', hideDialog);
$('#help-close').addEventListener('click', hideDialog);
$('#modal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideDialog();
  if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
    if (dialogShown('dlg-group')) submitGroupDialog();
    else if (dialogShown('dlg-text')) submitText();
  }
});

$('#btn-new-group').addEventListener('click', openGroupDialog);
$('#btn-welcome').addEventListener('click', openGroupDialog);
$('#btn-config').addEventListener('click', () => send({ type: 'open-config' }));
$('#btn-help').addEventListener('click', () => showDialog('dlg-help'));
$('#tb-fork').addEventListener('mousedown', (e) => e.preventDefault());
$('#tb-fork').addEventListener('click', () => forkPane());

// ======================================================================= global keys
const KEYS = {
  KeyN: openGroupDialog,
  KeyT: () => addPane(),
  KeyD: () => { const p = focusedPane(); p ? splitPane(p.id, 'row') : addPane(); },
  KeyE: () => { const p = focusedPane(); p ? splitPane(p.id, 'col') : addPane(); },
  KeyW: () => { const p = focusedPane(); p && closePane(p.id); },
  KeyR: () => { const p = focusedPane(); p && restartPane(p.id); },
  KeyZ: () => toggleZoom(),
  KeyF: () => forkPane(),
  KeyJ: jumpToAsk,
  KeyB: () => { document.body.classList.toggle('no-sidebar'); saveSoon(); },
  KeyC: () => { const p = focusedPane(); p && copySelection(p); },
  KeyV: () => { const p = focusedPane(); p && send({ type: 'clip-get', id: p.id }); },
  PageUp: () => cycleGroup(-1),
  PageDown: () => cycleGroup(1),
  ArrowLeft: () => moveFocus('left'),
  ArrowRight: () => moveFocus('right'),
  ArrowUp: () => moveFocus('up'),
  ArrowDown: () => moveFocus('down'),
  Equal: () => setFontSize(fontSize + 1),
  NumpadAdd: () => setFontSize(fontSize + 1),
  Minus: () => setFontSize(fontSize - 1),
  NumpadSubtract: () => setFontSize(fontSize - 1),
  Digit0: () => setFontSize(config.fontSize || 13),
};

window.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || dialogOpen()) return;
  const fn = KEYS[e.code] || (e.key.length > 1 && KEYS[e.key]);
  if (!fn) return;
  e.preventDefault();
  e.stopPropagation(); // keep it away from the terminal
  fn();
}, true);

// ======================================================================= go
send({ type: 'ready' });
