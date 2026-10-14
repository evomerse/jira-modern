const { contextBridge, ipcRenderer } = require('electron');

// Petit pont sécurisé : l'interface peut ramener la fenêtre au premier plan (clic sur une notification).
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  show: () => ipcRenderer.send('desktop:show'),
  autostart: (on) => ipcRenderer.invoke('desktop:autostart', on),
});
