'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Minimal, safe surface exposed to the admin web app.
contextBridge.exposeInMainWorld('__fwwDesktop', {
  isDesktop: true,
  app: 'b2b-admin',
  getVersion: () => ipcRenderer.invoke('app:version'),
  onUpdaterStatus: (cb) => ipcRenderer.on('updater:status', (_e, status) => cb(status)),
});
