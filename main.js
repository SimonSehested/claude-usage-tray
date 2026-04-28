const { app, BrowserWindow, Tray, nativeImage, ipcMain, Menu, screen, nativeTheme } = require('electron');
const path  = require('path');
const https = require('https');

if (!app.requestSingleInstanceLock()) { app.quit(); }

// ── Paths & constants ─────────────────────────────────────────────────────────

const API_KEY    = process.env.MINIMAX_API_KEY;
const API_HOST   = process.env.MINIMAX_API_HOST || 'api.minimax.chat';
const API_PATH   = process.env.MINIMAX_API_USAGE_PATH || '/v1/usage';
const REFRESH_MS = 5 * 60 * 1000;

let tray        = null;
let win         = null;
let windowReady = false;
let isQuitting  = false;
let usageData   = null;
let lastError   = null;
let lastUpdated = null;
let lastValidIcon = null;

// ── Token / API ───────────────────────────────────────────────────────────────

function fetchUsage() {
  return new Promise((resolve, reject) => {
    if (!API_KEY) {
      return reject(new Error('MINIMAX_API_KEY not set in environment.'));
    }
    const req = https.request({
      hostname: API_HOST,
      path:     API_PATH,
      method:   'GET',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type':  'application/json',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Invalid or expired API key.'));
        if (res.statusCode === 429) { const e = new Error('Rate limited'); e.isRateLimit = true; return reject(e); }
        if (res.statusCode !== 200) return reject(new Error(`API error ${res.statusCode}`));
        try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid API response')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Tray icon — SVG, no background, theme-adaptive track ─────────────────────

function usageColor(v) {
  if (!v || v < 0.60) return '#34C759';
  if (v < 0.85) return '#FF9F0A';
  return '#FF3B30';
}


function makeTrayIcon(sd, fh) {
  const sdColor = usageColor(sd);
  const fhColor = usageColor(fh);

  const svg = `<svg width="32" height="32" xmlns="http://www.w3.org/2000/svg">
    <circle cx="16" cy="16" r="12" fill="none" stroke="${sdColor}" stroke-width="4"/>
    <circle cx="16" cy="16" r="5"  fill="${fhColor}"/>
  </svg>`;

  try {
    const icon = nativeImage.createFromDataURL(
      'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
    );
    if (icon.isEmpty()) {
      return lastValidIcon || icon;
    }
    lastValidIcon = icon;
    return icon;
  } catch {
    return lastValidIcon || nativeImage.createEmpty();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalise(v) { v = parseFloat(v); return v > 1 ? v / 100 : v; }

function buildTooltip() {
  if (lastError) return 'MiniMax Usage — Error';
  if (!usageData) return 'MiniMax Usage — Loading…';
  const parts = [];
  const sd = usageData.seven_day, fh = usageData.five_hour;
  if (sd?.utilization != null) parts.push(`7d: ${Math.round(normalise(sd.utilization) * 100)}%`);
  if (fh?.utilization != null) parts.push(`5h: ${Math.round(normalise(fh.utilization) * 100)}%`);
  return parts.length ? 'MiniMax Usage — ' + parts.join(' | ') : 'MiniMax Usage';
}

function updateTray() {
  if (!tray) return;
  let sd = null, fh = null;
  if (usageData) {
    const sdv = usageData.seven_day, fhv = usageData.five_hour;
    if (sdv?.utilization != null) sd = normalise(sdv.utilization);
    if (fhv?.utilization != null) fh = normalise(fhv.utilization);
  }
  tray.setImage(makeTrayIcon(sd, fh));
  tray.setToolTip(buildTooltip());
}

// ── Refresh ───────────────────────────────────────────────────────────────────

async function refresh() {
  try {
    usageData   = await fetchUsage();
    lastError   = null;
    lastUpdated = new Date();
  } catch (e) {
    if (!e.isRateLimit) lastError = e.message;
    // On 429: keep existing usageData and lastUpdated silently
  }
  updateTray();
  if (windowReady && win?.isVisible()) {
    win.webContents.send('usage-data', { usageData, lastError, lastUpdated });
  }
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width:           360,
    height:          540,
    minWidth:        360,
    minHeight:       200,
    frame:           false,
    backgroundColor: '#F2F2F7',
    alwaysOnTop:     true,
    skipTaskbar:     true,
    resizable:       false,
    show:            false,
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => { windowReady = true; });
  win.on('blur', () => {
    if (!win.webContents.isDevToolsFocused()) win.hide();
  });
}

function positionWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const [w, h] = win.getSize();
  win.setPosition(workArea.x + workArea.width - w - 14,
                  workArea.y + workArea.height - h - 14);
}

function showWindow() {
  positionWindow();
  win.show();
  win.focus();
}

// ── IPC ───────────────────────────────────────────────────────────────────────

ipcMain.handle('get-usage', async () => {
  await refresh();
  return { usageData, lastError, lastUpdated };
});

ipcMain.on('close-window', () => win?.hide());

ipcMain.on('update-tray-icon', (_, dataUrl) => {
  try { tray?.setImage(nativeImage.createFromDataURL(dataUrl)); } catch {}
});

ipcMain.on('set-window-height', (_, h) => {
  const clamped = Math.max(200, Math.min(Math.round(h), 680));
  win.setSize(360, clamped, false);
  positionWindow();
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  app.setAppUserModelId('com.simonse.minimaxusage');

  tray = new Tray(makeTrayIcon(null, null));
  tray.setToolTip('MiniMax Usage — Loading…');

  // Re-render icon whenever the user switches light/dark mode
  nativeTheme.on('updated', updateTray);

  const ctxMenu = Menu.buildFromTemplate([
    { label: 'View Usage', click: async () => {
        if (!win.isVisible()) {
          await refresh();
          showWindow();
          if (windowReady) win.webContents.send('usage-data', { usageData, lastError, lastUpdated });
        }
      }
    },
    { label: 'Refresh Now', click: () => refresh() },
    { type: 'separator' },
    { label: 'Quit MiniMax Usage', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(ctxMenu);

  tray.on('click', async () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      await refresh();
      showWindow();
      if (windowReady) win.webContents.send('usage-data', { usageData, lastError, lastUpdated });
    }
  });

  createWindow();
  refresh();
  setInterval(refresh, REFRESH_MS);
});

app.on('second-instance', () => { if (win) showWindow(); });
app.on('before-quit',       () => { isQuitting = true; });
app.on('window-all-closed', e  => { if (!isQuitting) e.preventDefault(); });
