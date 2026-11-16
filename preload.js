'use strict';
// Gives the shared UI the same host API it gets from WebView2 on Windows:
//   host.postMessage(obj)  and  host.addEventListener('message', (ev) => ev.data)
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
ipcRenderer.on('host', (_e, m) => {
  for (const cb of listeners) {
    try { cb({ data: m }); } catch (err) { console.error(err); }
  }
});

contextBridge.exposeInMainWorld('agentmuxHost', {
  postMessage: (m) => ipcRenderer.send('host', m),
  addEventListener: (type, cb) => { if (type === 'message') listeners.add(cb); },
});
