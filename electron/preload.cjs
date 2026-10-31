'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webScanDesktop', Object.freeze({
  copyText: (value) => ipcRenderer.invoke('webscan:copy-text', value),
}));
