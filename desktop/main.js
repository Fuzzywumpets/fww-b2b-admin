'use strict';

const {
  app, BrowserWindow, ipcMain, Tray, Menu, nativeImage,
  shell, dialog, nativeTheme, session,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const Store = require('electron-store').default || require('electron-store');
const path = require('path');
const { pdfAttachmentHeaders } = require('./lib/pdf-headers');
const { unloadPromptOptions, shouldAllowUnload } = require('./lib/unload-prompt');

// ─── Constants ───────────────────────────────────────────────────────────────

const ADMIN_URL = 'https://b2badmin.fuzzywumpets.com/';
const APP_NAME  = 'FWW B2B Admin';
const ICON_PATH = path.join(__dirname, 'assets', 'icon.png');

// Origins allowed to open as in-app popups (the Google OAuth flow). Anything else
// opens in the user's default browser.
//
// CHANGE-GUARD: compared as EXACT origins via httpsOrigin() + Set.has(), never with
//   startsWith(). A prefix test accepts `https://accounts.google.com.evil.com`, which
//   is a real bypass — in-app windows share the authenticated persist:b2badmin
//   session, so whatever opens there inherits the admin's logged-in cookies.
const AUTH_ORIGINS = new Set([
  'https://b2badmin.fuzzywumpets.com',
  'https://accounts.google.com',
  'https://b2badmin.fuzzyreporting.com',
]);

// PDFs are only ever served BY the admin — Google is an OAuth origin, not a document
// source, so it is deliberately absent here.
// DEPENDS: isAdminPdfUrl() and both navigation interceptors gate on this.
const PDF_ORIGINS = new Set([
  'https://b2badmin.fuzzywumpets.com',
  'https://b2badmin.fuzzyreporting.com',
]);

// WHAT: Returns the URL's origin only if it parses AND is https, else null.
// INVARIANT(S): never throws on a malformed URL; a non-https scheme (file:, data:,
//   javascript:) always yields null, so every caller's Set.has() check fails closed.
function httpsOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.origin : null;
  } catch (_) {
    return null;
  }
}

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

// WHAT: True only for an https PDF served by an admin origin.
// CHANGE-GUARD: the `.pdf` regex alone is just a filename heuristic — an attacker-supplied
//   link ending in `.pdf` would otherwise be loaded into a window holding the admin's
//   session. The origin check is the actual security boundary; do not drop it and keep
//   only the regex.
function isAdminPdfUrl(url) {
  if (!/\.pdf($|[?#])/i.test(url || '')) return false;
  return PDF_ORIGINS.has(httpsOrigin(url));
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

// ─── Downloads ────────────────────────────────────────────────────────────────
//
// WHY: invoices were being saved out of this app with NO file extension at all
//   (`C:\Users\AlexLass\Downloads\August invoice`), so Windows could not open them — reported
//   2026-08-17. With no will-download handler, Electron shows a bare OS save dialog carrying no
//   file-type filter, so a name typed by the user is written verbatim and the `.pdf` is lost.
//   The server now serves ?download=1 as an attachment, but the embedded PDF viewer's own Save
//   button bypasses that entirely, so the extension has to be guaranteed HERE too.

// WHAT: guarantees a `.pdf` suffix on a suggested download filename.
// INVARIANT(S): never returns an empty name — a blank suggestion is what let the OS dialog open
//   with no name and no extension in the first place.
function pdfFilename(name) {
  const base = String(name || '').trim() || 'invoice';
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}

// WHAT: forces every PDF saved from ANY window in the admin session to keep its .pdf extension.
// CHANGE-GUARD: attaches to the 'persist:b2badmin' partition, which is shared by the main window
//   AND every openPdfWindow() — if a window is ever given a different partition, this handler stops
//   applying to it and extension-less saves come back. The `filters` entry is what makes Windows
//   append `.pdf` when the user retypes the name; do not drop it and keep only defaultPath.
function setupDownloadHandling() {
  const ses = session.fromPartition('persist:b2badmin');

  ses.on('will-download', (event, item) => {
    const isPdf = item.getMimeType() === 'application/pdf'
      || /\.pdf($|[?#])/i.test(item.getURL() || '');
    if (!isPdf) return;
    item.setSaveDialogOptions({
      defaultPath: path.join(app.getPath('downloads'), pdfFilename(item.getFilename())),
      filters: [{ name: 'PDF document', extensions: ['pdf'] }],
    });
  });

  // WHAT: stops any PDF from taking over the MAIN window, decided by Content-Type rather than by
  //   the URL. An inline PDF here becomes a download, so the window never navigates away.
  // WHY: `isAdminPdfUrl` matches only URLs containing `.pdf`. POST /orders/:id/partial-invoice has
  //   none, so it sailed past will-navigate and rendered IN the main window — which has no back
  //   button and whose X quits the whole app (see mainWindow's close handler). alexa hit this twice.
  //   The URL rule stays as the fast path for `.pdf` previews; this is the net under it.
  // CHANGE-GUARD: the resourceType/webContentsId scoping is load-bearing. 'mainFrame' excludes the
  //   invoice viewer's <iframe> and the webContentsId check excludes openPdfWindow — both MUST keep
  //   rendering inline or PDF preview turns into a download loop. Widen this and you break preview.
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame') return callback({});
    if (!mainWindow || mainWindow.isDestroyed()) return callback({});
    if (details.webContentsId !== mainWindow.webContents.id) return callback({});

    const rewritten = pdfAttachmentHeaders(details.responseHeaders);
    if (!rewritten) return callback({});
    callback({ responseHeaders: rewritten });
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  buildAppMenu();
  // DEPENDS: must run BEFORE createMainWindow() — the handler has to be attached to the partition
  //   before any window can start a download in it.
  setupDownloadHandling();
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
        // Insurance, not the fix: the PDF guard in setupDownloadHandling should mean the main window
        // never strands the user on a document. But this window has no browser chrome at all, so
        // when something DOES go wrong "Home" was the only way out and it was not discoverable —
        // alexa's report was "I cannot x out of it without killing the whole B2B shell". Alt+Left is
        // the reflex people already have.
        { label: 'Back', accelerator: 'Alt+Left', click: () => {
          const wc = mainWindow?.webContents;
          if (wc?.navigationHistory?.canGoBack()) wc.navigationHistory.goBack();
          else mainWindow?.loadURL(ADMIN_URL);
        } },
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
        // SYNC: this item exists in BOTH the Help menu and the tray menu — keep them
//   pointed at the same handler so one path can't go silent while the other reports.
{ label: 'Check for Updates', click: () => checkForUpdatesInteractive() },
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
    if (isAdminPdfUrl(url)) { openPdfWindow(url); return { action: 'deny' }; }
    if (AUTH_ORIGINS.has(httpsOrigin(url))) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // A plain (same-window) link to a PDF — e.g. the orders-list "invoice" link — would
  // otherwise navigate the MAIN window to the inline PDF, stranding the user with no
  // back button (the reported "have to restart the app" bug). Intercept ONLY PDF
  // navigations and open them in their own window; leave all normal admin nav alone.
  // SYNC: mirrors the PDF branch in setWindowOpenHandler above — both entry points must
  //   apply the SAME origin check, or one becomes a way around the other.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAdminPdfUrl(url)) {
      event.preventDefault();
      openPdfWindow(url);
      return;
    }
    // A `.pdf` link from anywhere else must not render in the MAIN window either —
    // that window holds the admin session. Hand it to the system browser instead.
    if (/\.pdf($|[?#])/i.test(url || '')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // WHAT: gives `beforeunload` a visible Leave/Stay dialog, the way a browser does.
  // WHY: Electron shows NOTHING for beforeunload by default — with no listener here, a page that
  //   cancels its unload cancels it SILENTLY. On 2026-08-28 one line-item edit that Shopify would
  //   never accept left the order page permanently "dirty", and from that moment every nav link,
  //   the back button, "Generate PDF" (a form POST, hence a navigation) and Quit itself all did
  //   nothing, with no message: "I can't even quit the electron shell app. impossible to quit
  //   without End Task." The page's own guard was reasonable; the missing dialog is what turned it
  //   into a lock on the whole application.
  // CHANGE-GUARD: preventDefault() here is INVERTED versus every other Electron event — it means
  //   "ignore the page's beforeunload and ALLOW the unload". Not calling it is what keeps the user
  //   on the page. shouldAllowUnload() is named for what it returns; do not negate it at this call
  //   site. Never remove this listener without replacing it with another way out of a dirty page.
  // DEPENDS: server-rendered pages register the beforeunload guards this answers — the order-detail
  //   autosave controller and the new-order form in server.mjs. Their "Leave anyway" control is the
  //   fallback for operators still running an older build of this shell.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, unloadPromptOptions());
    if (shouldAllowUnload(choice)) event.preventDefault();
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
    // SYNC: this item exists in BOTH the Help menu and the tray menu — keep them
//   pointed at the same handler so one path can't go silent while the other reports.
{ label: 'Check for Updates', click: () => checkForUpdatesInteractive() },
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

// WHAT: True while a check the USER explicitly asked for is in flight.
// DEPENDS: the update-not-available / error handlers below, which stay silent for the
//   automatic launch + 4-hourly checks (nagging every 4 hours is worse than useless) and
//   only surface a dialog when this is set. checkForUpdatesInteractive() is the ONLY
//   thing that should set it.
let manualUpdateCheck = false;

// WHAT: The "Check for Updates" menu/tray action — same check as the background one, but
//   it always reports an outcome.
// CHANGE-GUARD: previously this called autoUpdater.checkForUpdates() bare, and because
//   there was no update-not-available handler, "you're up to date", "you're offline" and
//   "the release feed 404s" were all indistinguishable from a dead menu item. Any rewrite
//   must keep every branch terminating in visible feedback.
function checkForUpdatesInteractive() {
  if (!app.isPackaged) {
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: APP_NAME, buttons: ['OK'],
      message: 'Updates are disabled in development.',
      detail: 'This is an unpackaged dev build, so there is no installed version to update.',
    });
    return;
  }
  manualUpdateCheck = true;
  // CHANGE-GUARD: the call must happen INSIDE .then(), not as an argument to
  //   Promise.resolve(...). As an argument it is evaluated first, so a synchronous
  //   throw escapes the .catch() entirely — and the click handlers have no try/catch
  //   of their own, so it would reach the main process unhandled with no feedback.
  Promise.resolve()
    .then(() => autoUpdater.checkForUpdates())
    .catch((e) => {
      // The 'error' handler below normally fires and owns the dialog; this catch only
      // covers a throw/rejection that never emits an event, so it must not double-report.
      if (!manualUpdateCheck) return;
      manualUpdateCheck = false;
      dialog.showMessageBox(mainWindow, {
        type: 'error', title: 'Update Check Failed', buttons: ['OK'],
        message: 'Could not check for updates.',
        detail: String(e?.message || e),
      });
    });
}

function setupAutoUpdater() {
  if (!app.isPackaged) return; // skip in dev

  autoUpdater.autoDownload         = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log(`[updater] update available: ${info.version}`);
    // CHANGE-GUARD: do NOT clear manualUpdateCheck here. This is not a terminal state —
    //   the download still has to succeed, and clearing now would make a failure during
    //   that download silent for a check the user explicitly asked for, which is the
    //   exact bug this whole function exists to fix. ('update-not-available' cannot also
    //   fire for the same check, so there is no "up to date" message to suppress.)
    mainWindow?.webContents.send('updater:status', { type: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] no update available');
    if (!manualUpdateCheck) return;
    manualUpdateCheck = false;
    dialog.showMessageBox(mainWindow, {
      type: 'info', title: APP_NAME, buttons: ['OK'],
      message: `${APP_NAME} ${app.getVersion()} is up to date.`,
      detail: 'You already have the latest released version.',
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[updater] update downloaded: ${info.version}`);
    // Terminal state for a manual check — the restart prompt below IS its feedback.
    manualUpdateCheck = false;
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

  autoUpdater.on('error', (e) => {
    console.error('[updater] error:', e.message);
    // Background checks fail quietly (offline laptops shouldn't pop dialogs); a check the
    // user clicked must say so, or it looks identical to a broken menu item.
    if (!manualUpdateCheck) return;
    manualUpdateCheck = false;
    dialog.showMessageBox(mainWindow, {
      type: 'error', title: 'Update Check Failed', buttons: ['OK'],
      message: 'Could not check for updates.',
      detail: String(e?.message || e),
    });
  });

  // Check on startup, then every 4 hours while open.
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}
