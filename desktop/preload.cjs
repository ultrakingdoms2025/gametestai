const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('aetherNexusDesktop', {
  platform: process.platform,
  version: process.versions.electron,
});
