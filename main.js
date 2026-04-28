const { app, BrowserWindow, Tray, nativeImage, ipcMain, Menu, screen, nativeTheme } = require('electron');
const path      = require('path');
const { exec }  = require('child_process');
const os        = require('os');

if (!app.requestSingleInstanceLock()) { app.quit(); }

// ── Paths & constants ─────────────────────────────────────────────────────────

const REFRESH_MS = 5 * 60 * 1000;

let tray        = null;
let win         = null;
let windowReady = false;
let isQuitting  = false;
let usageData   = null;
let lastError   = null;
let lastUpdated = null;
let lastValidIcon = null;
let lastValidIconType = null;

// ── Token / mmx CLI quota ──────────────────────────────────────────────────────

function parseUtilization(model) {
  if (!model || model.current_interval_total_count === 0) return null;
  return model.current_interval_usage_count / model.current_interval_total_count;
}

function parseWeeklyUtilization(model) {
  if (!model || model.current_weekly_total_count === 0) return null;
  return model.current_weekly_usage_count / model.current_weekly_total_count;
}

function resolveUsageModels(models) {
  const findModel = (name) => models.find(m => m.model_name === name);

  const mmx = findModel('MiniMax-M*');
  const codingVlm = findModel('coding-plan-vlm');
  const codingSearch = findModel('coding-plan-search');

  const weekModel = mmx || codingVlm || codingSearch;

  const fiveHourCandidate = models.find(m =>
    m.model_name !== 'MiniMax-M*' &&
    m.model_name !== 'coding-plan-vlm' &&
    m.model_name !== 'coding-plan-search' &&
    m.current_interval_total_count > 0
  );

  const isFiveHourValid = fiveHourCandidate &&
    fiveHourCandidate.end_time > Date.now();

  if (isFiveHourValid) {
    return {
      five_hour: {
        utilization: parseUtilization(fiveHourCandidate),
        resets_at: new Date(fiveHourCandidate.end_time).toISOString(),
      },
      seven_day: {
        utilization: parseWeeklyUtilization(weekModel),
        resets_at: weekModel?.weekly_end_time ? new Date(weekModel.weekly_end_time).toISOString() : null,
      },
    };
  }

  return {
    five_hour: null,
    seven_day: {
      utilization: parseWeeklyUtilization(weekModel),
      resets_at: weekModel?.weekly_end_time ? new Date(weekModel.weekly_end_time).toISOString() : null,
    },
  };
}

function fetchUsage() {
  return new Promise((resolve, reject) => {
    exec('mmx quota show --output json --no-color', { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error('Failed to run mmx CLI. Is it installed?'));
      }
      try {
        const data = JSON.parse(stdout);
        if (data.base_resp?.status_msg !== 'success') {
          return reject(new Error(data.base_resp?.status_msg || 'mmx quota failed'));
        }

        const models = data.model_remains || [];
        const result = resolveUsageModels(models);

        if (!result.seven_day.utilization && !result.five_hour) {
          return reject(new Error('No usage data found'));
        }

        resolve(result);
      } catch (e) {
        reject(new Error('Invalid mmx output: ' + e.message));
      }
    });
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
  const icon = makeTrayIcon(sd, fh);
  tray.setImage(icon);
  tray.setToolTip(buildTooltip());
  lastValidIcon = icon;
  lastValidIconType = 'svg';
}

// ── Refresh ───────────────────────────────────────────────────────────────────

async function refresh() {
  console.log('refresh called');
  try {
    console.log('calling fetchUsage...');
    usageData   = await fetchUsage();
    console.log('fetchUsage done:', usageData);
    lastError   = null;
    lastUpdated = new Date();
  } catch (e) {
    console.log('fetchUsage error:', e.message);
    if (!e.isRateLimit) lastError = e.message;
  }
  updateTray();
  console.log('updateTray done, sending to window');
  if (win && win.isVisible()) {
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
  try {
    if (!dataUrl || !dataUrl.startsWith('data:image')) return;
    const img = nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) return;
    if (tray) {
      tray.setImage(img);
      lastValidIcon = img;
      lastValidIconType = 'custom';
    }
  } catch {}
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
    if (!win) { console.log('win is null'); return; }
    console.log('click handler called, visible:', win.isVisible());
    if (win.isVisible()) {
      win.hide();
    } else {
      await refresh();
      console.log('showing window now');
      win.show();
      win.focus();
      if (windowReady) {
        win.webContents.send('usage-data', { usageData, lastError, lastUpdated });
      }
    }
  });

  createWindow();
  refresh();
  setInterval(refresh, REFRESH_MS);
});

app.on('second-instance', () => { if (win) showWindow(); });
app.on('before-quit',       () => { isQuitting = true; });
app.on('window-all-closed', e  => { if (!isQuitting) e.preventDefault(); });
