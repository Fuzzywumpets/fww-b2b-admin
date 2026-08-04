'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe surface exposed to the admin web app.
contextBridge.exposeInMainWorld('__fwwDesktop', {
  isDesktop: true,
  app: 'b2b-admin',
  getVersion: () => ipcRenderer.invoke('app:version'),
  // Returns an unsubscribe function. Callers that re-register (e.g. a component
  // remounting) MUST call it, or each mount leaves another live listener behind
  // and every updater event fires the callback once per stale registration.
  onUpdaterStatus: (cb) => {
    const listener = (_e, status) => cb(status);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
});
