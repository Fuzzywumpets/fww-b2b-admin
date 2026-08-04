'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage,
  shell, dialog, nativeTheme,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store').default || require('electron-store');
const path = require('path');

// ─── Constants ───────────────────────────────────────────────────────────────

const ADMIN_URL = 'https://b2badmin.fuzzywumpets.com/';
const APP_NAME  = 'FWW B2B Admin';
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

// Hosts allowed to open as in-app popups (the Google OAuth flow). Anything else
// opens in the user's default browser.
const AUTH_HOSTS = [
  'https://b2badmin.fuzzywumpets.com',
  'https://accounts.google.com',
  'https://b2badmin.fuzzyreporting.com',
];

// ─── Persistent settings (window bounds only) ────────────────────────────────

const store = new Store({
  name: 'config',
  defaults: { windowBounds: { width: 1440, height: 900 } },
});

// ─── Single instance lock ─────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

// ─── Globals ─────────────────────────────────────────────────────────────────

let mainWindow = null;
let tray       = null;
let quitting   = false;
let pdfWindows = [];

// ─── PDF / document windows ─────────────────────────────────────────────────────
//
// Invoice + packing-label PDFs are auth-gated (Google OAuth, persist:b2badmin), so the
// signed-out system browser can't load them — they open in an in-app window that SHARES
// the session. Each gets its own standalone window so the user simply closes it to
// return; the MAIN window is never navigated away to a chromeless inline PDF (which had
// no back button and forced an app restart).

function isPdfUrl(url) {
  return /\.pdf($|[?#])/i.test(url || '');
}

function openPdfWindow(url) {
  const win = new BrowserWindow({
    width: 1000,
    height: 820,
    title: 'Document — ' + APP_NAME,
    icon: ICON_PATH,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: { partition: 'persist:b2badmin' },
  });
  win.setMenuBarVisibility(false);
  win.on('closed', () => { pdfWindows = pdfWindows.filter((w) => w !== win); });
  pdfWindows.push(win);
  win.loadURL(url);
  return win;
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  buildAppMenu();
  createMainWindow();
  createTray();
  setupAutoUpdater();
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  // Closing the window fully exits — no lingering background instance holding
  // the single-instance lock and blocking reopen.
  app.quit();
});

// ─── Application menu ──────────────────────────────────────────────────────────

function buildAppMenu() {
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
        { label: 'Home', click: () => mainWindow?.loadURL(ADMIN_URL) },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Developer Tools', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Check for Updates', click: () => { try { autoUpdater.checkForUpdates(); } catch (_) {} } },
        { label: 'About', click: () => {
          dialog.showMessageBox(mainWindow, {
            type: 'info', title: APP_NAME,
            message: `${APP_NAME} ${app.getVersion()}`,
            detail: 'Desktop shell for b2badmin.fuzzywumpets.com.\nSigned in with Google; updates install automatically.',
            buttons: ['OK'],
          });
        } },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

// ─── Main window ─────────────────────────────────────────────────────────────

function createMainWindow() {
  const bounds = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width:  bounds.width,
    height: bounds.height,
    minWidth:  1000,
    minHeight: 640,
    title: APP_NAME,
    icon:  ICON_PATH,
    backgroundColor: '#1a1a1a',
    show: false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      // Persist cookies so the Google OAuth session survives restarts —
      // same approach as FWW Shipping.
      partition:        'persist:b2badmin',
    },
  });

  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      store.set('windowBounds', mainWindow.getBounds());
    }
  });

  mainWindow.on('close', () => {
    quitting = true;
    BrowserWindow.getAllWindows().forEach((w) => {
      if (w !== mainWindow) { try { w.destroy(); } catch (_) {} }
    });
    app.quit();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // Let the Google OAuth popup open in-app; send everything else to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Invoice / packing-label PDFs -> dedicated in-app window (shares the authed
    // session); never a chromeless popup or the signed-out system browser.
    if (isPdfUrl(url)) { openPdfWindow(url); return { action: 'deny' }; }
    if (AUTH_HOSTS.some((h) => url.startsWith(h))) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // A plain (same-window) link to a PDF — e.g. the orders-list "invoice" link — would
  // otherwise navigate the MAIN window to the inline PDF, stranding the user with no
  // back button (the reported "have to restart the app" bug). Intercept ONLY PDF
  // navigations and open them in their own window; leave all normal admin nav alone.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isPdfUrl(url)) {
      event.preventDefault();
      openPdfWindow(url);
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.loadURL(ADMIN_URL);
}

// ─── System tray ─────────────────────────────────────────────────────────────

function createTray() {
  const img = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { type: 'separator' },
    { label: 'Open', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: 'Check for Updates', click: () => { try { autoUpdater.checkForUpdates(); } catch (_) {} } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ─── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('app:version', () => app.getVersion());

// ─── Auto updater ─────────────────────────────────────────────────────────────
//
// Checks GitHub Releases on every launch ("auto-update upon open"), downloads in
// the background, and offers to restart. Anything not installed at restart is
// applied automatically on next quit.

function setupAutoUpdater() {
  if (!app.isPackaged) return; // skip in dev

  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] update available: ${info.version}`);
    mainWindow?.webContents.send('updater:status', { type: 'available', version: info.version });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] update downloaded: ${info.version}`);
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `${APP_NAME} ${info.version} has been downloaded.`,
      detail: 'Restart now to apply it, or it will install automatically next time you quit.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    });
    if (choice === 0) { quitting = true; autoUpdater.quitAndInstall(); }
  });

  autoUpdater.on('error', (e) => console.error('[updater] error:', e.message));

  // Check on startup, then every 4 hours while open.
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}
