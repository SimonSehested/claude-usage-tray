const { app, BrowserWindow, Tray, nativeImage, ipcMain, Menu, screen } = require('electron');
const path  = require('path');
const fs    = require('fs');
const https = require('https');
const os    = require('os');

if (!app.requestSingleInstanceLock()) { app.quit(); }

// ── Paths & constants ─────────────────────────────────────────────────────────

const CREDENTIALS_PATH = path.join(
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  '.credentials.json'
);
const REFRESH_MS = 5 * 60 * 1000;

let tray        = null;
let win         = null;
let windowReady = false;
let isQuitting  = false;
let usageData   = null;
let lastError   = null;
let lastUpdated = null;

// ── Token / API ───────────────────────────────────────────────────────────────

function loadToken() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'))
      .claudeAiOauth.accessToken;
  } catch { return null; }
}

function fetchUsage() {
  return new Promise((resolve, reject) => {
    const token = loadToken();
    if (!token) {
      return reject(new Error('Claude Code credentials not found. Run "claude" in a terminal first.'));
    }
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/api/oauth/usage',
      method:   'GET',
      headers: {
        'Authorization':    `Bearer ${token}`,
        'Content-Type':     'application/json',
        'anthropic-beta':   'oauth-2025-04-20',
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Token expired — run "claude" in a terminal.'));
        if (res.statusCode !== 200) return reject(new Error(`API error ${res.statusCode}`));
        try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid API response')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Tray icon (SVG, updated with PNG from renderer once loaded) ───────────────

function makePlaceholderIcon() {
  const svg = `<svg width="32" height="32" xmlns="http://www.w3.org/2000/svg">
    <rect width="32" height="32" rx="7" fill="#1C1C2E"/>
    <circle cx="16" cy="16" r="10" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="3"/>
    <circle cx="16" cy="16" r="5.5" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2.5"/>
  </svg>`;
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
  );
}

function normalise(v) { v = parseFloat(v); return v > 1 ? v / 100 : v; }

function buildTooltip() {
  if (lastError) return 'Claude Usage — Error';
  if (!usageData) return 'Claude Usage — Loading…';
  const parts = [];
  const sd = usageData.seven_day, fh = usageData.five_hour;
  if (sd?.utilization != null) parts.push(`7d: ${Math.round(normalise(sd.utilization) * 100)}%`);
  if (fh?.utilization != null) parts.push(`5h: ${Math.round(normalise(fh.utilization) * 100)}%`);
  return parts.length ? 'Claude Usage — ' + parts.join(' | ') : 'Claude Usage';
}

// ── Refresh ───────────────────────────────────────────────────────────────────

async function refresh() {
  try {
    usageData   = await fetchUsage();
    lastError   = null;
    lastUpdated = new Date();
  } catch (e) {
    lastError = e.message;
  }
  tray?.setToolTip(buildTooltip());
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
    transparent:     true,
    backgroundColor: '#00000000',
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

  // Windows 11 native acrylic material (graceful fallback on older OS)
  if (process.platform === 'win32') {
    try { win.setBackgroundMaterial('acrylic'); } catch {}
  }

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
  try {
    tray?.setImage(nativeImage.createFromDataURL(dataUrl));
  } catch {}
});

ipcMain.on('set-window-height', (_, h) => {
  const clamped = Math.max(200, Math.min(Math.round(h), 680));
  win.setSize(360, clamped, false);
  positionWindow();
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  app.setAppUserModelId('com.simonse.claudeusage');

  tray = new Tray(makePlaceholderIcon());
  tray.setToolTip('Claude Usage — Loading…');

  const ctxMenu = Menu.buildFromTemplate([
    { label: 'View Usage',  click: async () => {
        if (!win.isVisible()) {
          await refresh();
          showWindow();
          if (windowReady) win.webContents.send('usage-data', { usageData, lastError, lastUpdated });
        }
      }
    },
    { label: 'Refresh Now', click: () => refresh() },
    { type: 'separator' },
    { label: 'Quit Claude Usage', click: () => { isQuitting = true; app.quit(); } },
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
