'use strict';

// ── Helpers ───────────────────────────────────────────────────────────────────

const normalise = v => { v = parseFloat(v); return v > 1 ? v / 100 : v; };

function usageColor(v) {
  if (v < 0.60) return '#34C759';
  if (v < 0.85) return '#FF9F0A';
  return '#FF3B30';
}

function fmtReset(resetsAt) {
  if (!resetsAt) return '';
  try {
    const secs = (new Date(resetsAt) - Date.now()) / 1000;
    if (secs <= 0) return 'Resetting soon';
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (d) return `Resets in ${d}d ${h}h`;
    if (h) return `Resets in ${h}h ${m}m`;
    return `Resets in ${m}m`;
  } catch { return ''; }
}

// ── Donut ring canvas ─────────────────────────────────────────────────────────

function drawRings(canvas, sdUtil, fhUtil) {
  const dpr  = window.devicePixelRatio || 1;
  const size = 190;
  canvas.width  = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width  = size + 'px';
  canvas.style.height = size + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const cx = size / 2, cy = size / 2;
  const outerR = 79, innerR = 51;
  const outerW = 9,  innerW = 6;
  const track  = 'rgba(0, 0, 0, 0.07)';

  function ring(r, w, util) {
    // Track
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = track;
    ctx.lineWidth   = w;
    ctx.lineCap     = 'butt';
    ctx.stroke();

    // Progress arc
    if (util > 0.002) {
      const end = Math.min(util, 0.9999) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + end);
      ctx.strokeStyle = usageColor(util);
      ctx.lineWidth   = w;
      ctx.lineCap     = 'round';
      ctx.stroke();
    }
  }

  ring(outerR, outerW, sdUtil);
  ring(innerR, innerW, fhUtil);

  // Center percentage
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = usageColor(sdUtil);
  ctx.font      = `bold 30px system-ui, -apple-system, sans-serif`;
  ctx.fillText(`${Math.round(sdUtil * 100)}%`, cx, cy - 10);

  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.font      = `500 12px system-ui, -apple-system, sans-serif`;
  ctx.fillText('7-Day', cx, cy + 14);
}


// ── Tray icon — canvas PNG sent to main process ───────────────────────────────

function renderTrayIcon(sdUtil, fhUtil) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const cx = 32, cy = 32;

  // Outer ring = 7-day color
  ctx.beginPath();
  ctx.arc(cx, cy, 26, 0, Math.PI * 2);
  ctx.strokeStyle = usageColor(sdUtil || 0);
  ctx.lineWidth = 10;
  ctx.stroke();

  // Inner filled dot = 5-hour color
  ctx.beginPath();
  ctx.arc(cx, cy, 11, 0, Math.PI * 2);
  ctx.fillStyle = usageColor(fhUtil || 0);
  ctx.fill();

  window.electronAPI.updateTrayIcon(canvas.toDataURL('image/png'));
}

// ── Main render function ──────────────────────────────────────────────────────

function render(data) {
  const { usageData, lastError, lastUpdated } = data;
  const content = document.getElementById('content');

  if (lastError) {
    content.innerHTML = `<div class="error-msg">⚠&nbsp; ${escHtml(lastError)}</div>`;
    adjustHeight();
    return;
  }

  if (!usageData) {
    content.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <span>Fetching usage data…</span>
      </div>`;
    adjustHeight();
    return;
  }

  const sdv    = usageData.seven_day;
  const fhv    = usageData.five_hour;
  const sdUtil = sdv?.utilization != null ? normalise(sdv.utilization) : 0;
  const fhUtil = fhv?.utilization != null ? normalise(fhv.utilization) : 0;

  const resets = [fmtReset(sdv?.resets_at), fmtReset(fhv?.resets_at)].filter(Boolean);

  // Extra model bars
  const EXTRA = [['seven_day_sonnet','7-Day Sonnet'],['seven_day_opus','7-Day Opus']];
  const bars = EXTRA
    .map(([k, label]) => {
      const v = usageData[k];
      return v?.utilization != null
        ? { label, util: normalise(v.utilization), resets: v.resets_at }
        : null;
    })
    .filter(Boolean);

  const barsHtml = bars.map(b => {
    const pct   = Math.round(b.util * 100);
    const color = usageColor(b.util);
    const reset = fmtReset(b.resets);
    return `
      <div class="bar-card">
        <div class="bar-header">
          <span class="bar-label">${escHtml(b.label)}</span>
          <span class="bar-pct" style="color:${color}">${pct}%</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width:0%;background:${color}" data-target="${pct}"></div>
        </div>
        ${reset ? `<div class="bar-reset">${reset}</div>` : ''}
      </div>`;
  }).join('');

  const resetRowHtml = resets.map(t =>
    `<div class="reset-row">${t}</div>`
  ).join('');

  content.innerHTML = `
    <div class="ring-section">
      <canvas id="ringCanvas"></canvas>
      <div class="legend">
        <div class="legend-item">
          <div class="legend-dot" style="background:${usageColor(sdUtil)}"></div>
          <span>7d&ensp;${Math.round(sdUtil * 100)}%</span>
        </div>
        <div class="legend-item">
          <div class="legend-dot" style="background:${usageColor(fhUtil)}"></div>
          <span>5h&ensp;${Math.round(fhUtil * 100)}%</span>
        </div>
      </div>
      ${resetRowHtml}
    </div>
    ${bars.length ? `<div class="separator"></div>${barsHtml}` : ''}
  `;

  drawRings(document.getElementById('ringCanvas'), sdUtil, fhUtil);

  // Animate bar fills after a tick so transition fires
  requestAnimationFrame(() => {
    document.querySelectorAll('.bar-fill[data-target]').forEach(el => {
      el.style.width = el.dataset.target + '%';
    });
  });

  // Update footer timestamp
  if (lastUpdated) {
    const t = new Date(lastUpdated);
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    document.getElementById('footer').textContent = `Updated ${hh}:${mm}`;
  }

  renderTrayIcon(sdUtil, fhUtil);
  adjustHeight();
}

function adjustHeight() {
  requestAnimationFrame(() => {
    const panel = document.getElementById('panel');
    if (!panel) return;
    // 20px = 10 top margin + 10 bottom margin
    window.electronAPI.setWindowHeight(panel.scrollHeight + 20);
  });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('closeBtn').addEventListener('click', () => {
    window.electronAPI.closeWindow();
  });

  // Push updates from background refresh
  window.electronAPI.onUsageData(render);

  // Initial fetch + render
  const data = await window.electronAPI.getUsage();
  render(data);

});
