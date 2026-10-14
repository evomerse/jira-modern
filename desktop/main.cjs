// Application de bureau Team-IT CDS : fenêtre native + serveur local intégré + icône de zone de notification.
const { app, BrowserWindow, Tray, Menu, nativeImage, utilityProcess, shell, session, ipcMain } = require('electron');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const PORT = 8787;
const URL = `http://127.0.0.1:${PORT}`;
const startHidden = process.argv.includes('--hidden');

app.setAppUserModelId('fr.teamit.cds'); // requis pour les notifications Windows

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let tray = null;
let server = null;
let quitting = false;
let lastUnread = 0;

const portOpen = () => new Promise((resolve) => {
  const s = net.connect({ port: PORT, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

async function startServer() {
  if (await portOpen()) return; // une instance (ou le mode dev) tourne déjà : on la réutilise
  // --use-system-ca : fait confiance aux certificats Windows (proxy d'entreprise qui inspecte le HTTPS).
  server = utilityProcess.fork(path.join(ROOT, 'server.js'), [], {
    execArgv: ['--use-system-ca'],
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    if (await portOpen()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Le serveur local n\'a pas démarré.');
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Team-IT CDS',
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(URL);
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });

  // Les liens externes (Jira, Confluence…) s'ouvrent dans le navigateur ; l'app reste sur son adresse.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(URL)) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });

  // Le titre porte le nombre de non-lus : « (3) Team-IT · CDS ».
  win.on('page-title-updated', (_e, title) => {
    const n = Number((title.match(/^\((\d+)\)/) || [])[1] || 0);
    if (tray) tray.setToolTip(n ? `Team-IT CDS — ${n} notification(s) non lue(s)` : 'Team-IT CDS');
    if (n > lastUnread && (!win.isVisible() || !win.isFocused())) win.flashFrame(true);
    lastUnread = n;
  });
  win.on('focus', () => win.flashFrame(false));

  // Fermer la fenêtre la réduit dans la zone de notification : la surveillance continue.
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(ROOT, 'build', 'tray.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Team-IT CDS');
  const menu = () => Menu.buildFromTemplate([
    { label: 'Ouvrir Team-IT CDS', click: showWindow },
    {
      label: 'Lancer au démarrage de Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { type: 'separator' },
    { label: 'Quitter', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', showWindow);
  tray.on('right-click', () => tray.setContextMenu(menu()));
}

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  // Seules les notifications sont autorisées côté permissions web.
  const allow = (permission) => permission === 'notifications';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allow(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allow(permission));

  ipcMain.on('desktop:show', showWindow);
  ipcMain.handle('desktop:autostart', (_e, on) => {
    if (typeof on === 'boolean') app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
    return app.getLoginItemSettings().openAtLogin;
  });

  try {
    await startServer();
  } catch (e) {
    const { dialog } = require('electron');
    dialog.showErrorBox('Team-IT CDS', String(e.message || e));
    app.quit();
    return;
  }
  createWindow();
  createTray();
});

app.on('window-all-closed', () => { /* on reste dans la zone de notification */ });
app.on('before-quit', () => {
  quitting = true;
  if (server) server.kill();
});
