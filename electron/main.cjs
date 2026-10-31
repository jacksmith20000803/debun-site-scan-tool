'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron');

// Scanner installations run on machines that may not have a usable GPU driver.
// Use Chromium's software renderer so a graphics-process failure cannot close
// the desktop app before the local scan server and window become available.
app.disableHardwareAcceleration();
// Keep Chromium's GPU helper from failing to initialize under restrictive
// Windows AppContainer policies. Only the local, sandboxed app UI uses this
// Electron process; external destinations open in the system browser.
app.commandLine.appendSwitch('disable-gpu-sandbox');

// Older installations may have stale Chromium cache ACLs in userData. Keep
// session/cache data in a fresh subdirectory while preserving scan records in
// the existing userData/storage location.
const sessionDataDirectory = path.join(app.getPath('temp'), 'Debun Plus', 'session-data');
fs.mkdirSync(sessionDataDirectory, { recursive: true });
app.setPath('sessionData', sessionDataDirectory);

let mainWindow;
let backendServer;
let appUrl;
let desktopLogPath;

ipcMain.handle('webscan:copy-text', (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Clipboard requests are only available to the WebScan window.');
  }
  if (typeof value !== 'string') throw new TypeError('Clipboard content must be text.');
  clipboard.writeText(value);
  return true;
});

function formatLogValue(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function writeDesktopLog(level, ...values) {
  const line = `${new Date().toISOString()} [${level}] ${values.map(formatLogValue).join(' ')}\n`;
  if (desktopLogPath) {
    try { fs.appendFileSync(desktopLogPath, line, 'utf8'); } catch (_) { /* Keep console output available if disk logging fails. */ }
  }
  return line;
}

function enableDesktopLogging() {
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  console.log = (...values) => {
    writeDesktopLog('info', ...values);
    originalLog(...values);
  };
  console.error = (...values) => {
    writeDesktopLog('error', ...values);
    originalError(...values);
  };
}

function waitForServer(server) {
  return new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#171717',
    icon: path.join(app.getAppPath(), 'ico.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  const origin = new URL(appUrl).origin;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === origin) {
      mainWindow.loadURL(url);
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(appUrl);

  if (!app.isPackaged && process.env.DEBUN_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

async function start() {
  const userDataDirectory = app.getPath('userData');
  fs.mkdirSync(userDataDirectory, { recursive: true });
  desktopLogPath = path.join(userDataDirectory, 'desktop.log');
  enableDesktopLogging();
  console.log('[debun-plus:desktop] startup', { userDataDirectory, appPath: app.getAppPath(), packaged: app.isPackaged });
  process.chdir(userDataDirectory);
  process.env.DEBUN_STORAGE_DIR = path.join(userDataDirectory, 'storage');
  process.env.HOST = '127.0.0.1';
  // Let the OS select an unused local port so desktop and web instances can coexist.
  process.env.PORT = '0';

  app.setAppUserModelId('com.debunplus.desktop');
  backendServer = require('../src/web-server.js');
  await waitForServer(backendServer);
  const { port } = backendServer.address();
  appUrl = `http://127.0.0.1:${port}/`;
  console.log('[debun-plus:desktop] local server ready', { url: appUrl, storage: process.env.DEBUN_STORAGE_DIR });
  createWindow();
}

app.whenReady().then(start).catch((error) => {
  console.error('[debun-plus:desktop] startup failed', error);
  dialog.showErrorBox('Debun Plus could not start', error.message || String(error));
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && appUrl) createWindow();
});

app.on('before-quit', () => {
  if (backendServer?.listening) backendServer.close();
});

app.on('window-all-closed', () => app.quit());
