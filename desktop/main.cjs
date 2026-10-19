// Application de bureau Team-IT CDS : fenêtre native + serveur local intégré + icône de zone de notification.
const { app, BrowserWindow, Tray, Menu, nativeImage, net, shell, session, ipcMain } = require('electron');
const path = require('node:path');
const nodeNet = require('node:net');
const { pathToFileURL } = require('node:url');

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
let quitting = false;
let lastUnread = 0;

const portOpen = () => new Promise((resolve) => {
  const s = nodeNet.connect({ port: PORT, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

// Proxy du système (PAC / proxy d'entreprise) pour les programmes lancés par l'application
// (Claude Code, serveur MCP) : ils n'utilisent pas la pile réseau de Chromium.
async function applySystemProxyToEnv() {
  try {
    const rule = await session.defaultSession.resolveProxy('https://moongy.atlassian.net');
    const m = String(rule).match(/^(PROXY|HTTPS)\s+([^;\s]+)/i);
    if (!m) return; // DIRECT : rien à faire
    const proxy = `${/^HTTPS/i.test(m[1]) ? 'https' : 'http'}://${m[2]}`;
    process.env.HTTPS_PROXY = proxy;
    process.env.HTTP_PROXY = proxy;
    process.env.NO_PROXY = '127.0.0.1,localhost';
    process.env.NODE_USE_ENV_PROXY = '1';
  } catch { /* pas de proxy détecté */ }
}

async function startServer() {
  if (await portOpen()) return; // une instance (ou le mode dev) tourne déjà : on la réutilise
  await applySystemProxyToEnv();
  // Le serveur local tourne dans ce processus et sort sur Internet via le réseau d'Electron :
  // proxy Windows, certificats du système et authentification intégrée fonctionnent comme dans Chrome.
  globalThis.fetch = (input, init) => net.fetch(input, init);
  process.env.PORT = String(PORT);
  await import(pathToFileURL(path.join(ROOT, 'server.js')).href);
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
  // Autorisation des scripts PowerShell : passe par l'application elle-même, donc fonctionne même si le serveur local est arrêté.
  ipcMain.handle('desktop:ps-policy', async (_e, apply) => {
    const { execFile } = require('node:child_process');
    const ps = (cmd) => new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 20000, windowsHide: true }, (_err, stdout, stderr) => resolve({ out: String(stdout || ''), err: String(stderr || '') }));
    });
    let error = '';
    if (apply) error = (await ps('Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force')).err.trim();
    const r = await ps('Get-ExecutionPolicy -List | ForEach-Object { $_.Scope.ToString() + "=" + $_.ExecutionPolicy.ToString() }');
    const list = {};
    r.out.split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => { const [k, v] = l.split('='); list[k] = v; });
    const effective = ['MachinePolicy', 'UserPolicy', 'Process', 'CurrentUser', 'LocalMachine'].map((k) => list[k]).find((v) => v && v !== 'Undefined') || 'Restricted';
    const locked = ['MachinePolicy', 'UserPolicy'].some((k) => list[k] && list[k] !== 'Undefined');
    return { effective, list, locked, ok: !['Restricted', 'AllSigned'].includes(effective), error };
  });
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
});
