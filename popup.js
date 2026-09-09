// Twitter Reply Cleaner - popup.js
const $ = (id) => document.getElementById(id);

let activeTabId = null;
let pollTimer = null;

const ui = {
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  deletedCount: $('deletedCount'),
  preview: $('preview'),
  pageStats: $('pageStats'),
  warning: $('warning'),
  error: $('error'),
  username: $('username'),
  usernameHint: $('usernameHint'),
  rate: $('rate'),
  locateBtn: $('locateBtn'),
  startBtn: $('startBtn'),
  controlRow: $('controlRow'),
  pauseBtn: $('pauseBtn'),
  resumeBtn: $('resumeBtn'),
  stopBtn: $('stopBtn'),
  diagBtn: $('diagBtn'),
};

// ----------------------------------------------------------------
// UI helpers
// ----------------------------------------------------------------
function setStatus(state, label) {
  ui.statusDot.className = 'dot ' + (state || '');
  ui.statusText.textContent = label;
}

function setError(msg) {
  if (msg) {
    ui.error.textContent = msg;
    ui.error.classList.add('show');
    ui.error.classList.remove('info');
  } else {
    ui.error.classList.remove('show');
    ui.error.classList.remove('info');
    ui.error.textContent = '';
  }
}

function setInfo(msg) {
  if (msg) {
    ui.error.textContent = msg;
    ui.error.classList.add('show');
    ui.error.classList.add('info');
  } else {
    ui.error.classList.remove('show');
    ui.error.classList.remove('info');
    ui.error.textContent = '';
  }
}

function setWarning(msg) {
  if (msg) {
    ui.warning.textContent = '⚠ ' + msg;
    ui.warning.classList.add('show');
  } else {
    ui.warning.classList.remove('show');
    ui.warning.textContent = '';
  }
}

function setPageStats(stats) {
  if (!ui.pageStats) return;
  if (!stats || typeof stats.total !== 'number') {
    ui.pageStats.classList.remove('show');
    return;
  }
  const { total, ownedCount, replyCount, samples } = stats;
  let html = '📊 本页: <strong>' + total + '</strong> 条推文，属于目标账号 <strong>' +
             (typeof ownedCount === 'number' ? ownedCount : '?') + '</strong> 条，识别为回复 <strong>' + replyCount + '</strong> 条';
  if (replyCount === 0 && total > 0) {
    html += '<br>⚠ <strong>没识别到任何回复</strong> — 可能是选择器失配或本页只有原创帖';
  } else if (samples && samples.length) {
    html += '<div class="sample">样例: ' + samples.map(s => '「' + s + '…」').join('  ') + '</div>';
  }
  ui.pageStats.innerHTML = html;
  ui.pageStats.classList.add('show');
}

function refreshButtons() {
  const running = lastStatus.running;
  const haveTab = !!activeTabId;

  // Username is optional — if empty, background auto-detects from the page.
  ui.startBtn.disabled = running || !haveTab;

  if (running) {
    ui.controlRow.classList.remove('hidden');
    ui.pauseBtn.classList.toggle('hidden', !!lastStatus.paused);
    ui.resumeBtn.classList.toggle('hidden', !lastStatus.paused);
  } else {
    ui.controlRow.classList.add('hidden');
  }
}

// ----------------------------------------------------------------
// Local status cache (single source of truth for rendering)
// ----------------------------------------------------------------
const lastStatus = {
  type: 'idle',
  running: false,
  deleted: 0,
  paused: false,
  currentPreview: '',
  warning: '',
  error: ''
};

// ----------------------------------------------------------------
// Background messaging
// ----------------------------------------------------------------
function forward(kind, extra = {}) {
  return new Promise((resolve) => {
    if (!activeTabId) { resolve({ ok: false, error: '请先点击"定位当前页面"。' }); return; }
    chrome.runtime.sendMessage({ kind, tabId: activeTabId, ...extra }, (resp) => {
      resolve(resp || { ok: false, error: 'no response' });
    });
  });
}
function bgGetStatus() {
  return new Promise(r => chrome.runtime.sendMessage({ kind: 'GET_STATUS' }, resp => r(resp || {})));
}
function bgFindTab() {
  return new Promise(r => chrome.runtime.sendMessage({ kind: 'FIND_TAB' }, resp => r(resp || {})));
}
function bgPingTab(tabId) {
  return new Promise(r => chrome.runtime.sendMessage({ kind: 'PING_TAB', tabId }, resp => r(resp || {})));
}
function bgReadStorage() {
  return new Promise(r => {
    try {
      chrome.storage.session.get('cleaner_state', (data) => r(data && data.cleaner_state));
    } catch (e) { r(null); }
  });
}

// ----------------------------------------------------------------
// Apply status to UI
// ----------------------------------------------------------------
function applyStatus(s) {
  if (!s) return;
  if (typeof s.deleted === 'number') {
    lastStatus.deleted = s.deleted;
    ui.deletedCount.textContent = s.deleted;
  }
  if (typeof s.running === 'boolean') lastStatus.running = s.running;
  if (typeof s.paused === 'boolean')  lastStatus.paused = s.paused;
  if (s.currentPreview !== undefined) {
    lastStatus.currentPreview = s.currentPreview || '';
    if (s.currentPreview) ui.preview.textContent = '「' + s.currentPreview + '…」';
    else ui.preview.textContent = '';
  }
  if (s.warning) setWarning(s.warning);
  else if (s.warning === '') setWarning('');

  if (s.type) {
    lastStatus.type = s.type;
    switch (s.type) {
      case 'idle':     setStatus('', '未启动'); break;
      case 'starting': setStatus('running', '准备中…'); break;
      case 'progress':
      case 'working':  setStatus('running', s.paused ? '已暂停' : '正在删除…'); break;
      case 'paused':   setStatus('paused', '已暂停'); break;
      case 'done':     setStatus('done', '✅ 完成,共删除 ' + (s.deleted || 0) + ' 条'); break;
      case 'stopped':  setStatus('', '⏹ 已停止,共删除 ' + (s.deleted || 0) + ' 条'); break;
      case 'error':    setStatus('error', '❌ 出错了'); setError(s.message || '未知错误'); break;
    }
  }
  refreshButtons();
}

// ----------------------------------------------------------------
// Seed from storage + content script PING (so the count is correct
// even if the popup is reopened after the background service worker
// was killed by Chrome)
// ----------------------------------------------------------------
async function seedStatus() {
  // 1. Try storage.session
  const stored = await bgReadStorage();
  if (stored && typeof stored.deleted === 'number' && stored.deleted > 0) {
    applyStatus({
      deleted: stored.deleted,
      running: !!stored.running,
      paused: !!stored.paused,
      currentPreview: stored.currentPreview || '',
      type: stored.running ? (stored.paused ? 'paused' : 'working') : 'idle'
    });
  }
  // 2. If we have an active tab, ping the content script for the freshest state
  if (activeTabId) {
    const r = await bgPingTab(activeTabId);
    if (r && r.ok && r.response) {
      const snap = r.response.snapshot;
      if (snap) {
        applyStatus({
          deleted: snap.deleted || 0,
          running: !!snap.running,
          paused: !!snap.paused,
          currentPreview: snap.currentPreview || '',
          type: snap.running ? (snap.paused ? 'paused' : 'working') : 'idle'
        });
      }
    }
  }
}

// ----------------------------------------------------------------
// Event wiring
// ----------------------------------------------------------------
ui.locateBtn.addEventListener('click', async () => {
  setError('');
  setInfo('');

  const r = await bgFindTab();
  if (!r || !r.tab) {
    setError('找不到 X / Twitter 页面。请先打开 https://x.com 并登录,然后再点定位。');
    refreshButtons();
    return;
  }
  activeTabId = r.tab.id;
  ui.locateBtn.textContent = '⏳ 注入中…';
  ui.locateBtn.disabled = true;

  const pingR = await bgPingTab(activeTabId);

  ui.locateBtn.textContent = '📍 定位当前页面';
  ui.locateBtn.disabled = false;

  if (!pingR || !pingR.ok) {
    setError('连接 X 页面失败: ' + (pingR && pingR.error || '未知错误'));
    activeTabId = null;
    refreshButtons();
    return;
  }
  const ping = pingR.response || {};

  if (!ping.loggedIn) {
    setError('已连接到 X 页面,但看起来未登录。请先登录,然后再点一次定位。');
  } else if (pingR.injected) {
    setInfo('✓ 已自动注入扩展到当前 X 页面。');
  } else {
    setInfo('✓ 已连接到 X 页面。');
  }

  // Auto-fill the username from the page (works on any X page, not just profile)
  if (ping.loggedInUsername) {
    ui.username.value = ping.loggedInUsername;
    ui.username.dataset.auto = '1';
    ui.usernameHint.textContent = '🔍 已自动识别: @' + ping.loggedInUsername;
    ui.usernameHint.className = 'hint ok';
  } else if (ui.username.value) {
    ui.username.dataset.auto = '0';
    ui.usernameHint.textContent = '✏️ 手动输入';
    ui.usernameHint.className = 'hint';
  } else {
    // Build a short diagnostic string of what was tried
    const tries = (ping.detectionLog || []).map(a => a.strategy).join(' / ');
    ui.usernameHint.textContent = '⚠ 未自动识别 — 请手动填写';
    ui.usernameHint.className = 'hint bad';
    ui.usernameHint.title = '试过的策略: ' + (tries || '无');
    setInfo('未自动识别当前账号。请在上方手动填写用户名(如 ' +
            location.pathname.match(/^\/([a-zA-Z0-9_]+)/)?.[1] + ')。' +
            (tries ? ' [策略: ' + tries + ']' : ''));
  }

  // Apply fresh state from content script (so count is correct immediately)
  if (ping.snapshot) {
    applyStatus({
      deleted: ping.snapshot.deleted || 0,
      running: !!ping.snapshot.running,
      paused: !!ping.snapshot.paused,
      currentPreview: ping.snapshot.currentPreview || '',
      type: ping.snapshot.running ? (ping.snapshot.paused ? 'paused' : 'working') : 'idle'
    });
  } else {
    refreshButtons();
  }
});

function validateAndStart() {
  setError('');
  setInfo('');

  if (!activeTabId) { setError('请先点击"定位当前页面"。'); return; }

  const u = ui.username.value.trim().replace(/^@/, '');
  // Username is optional - if empty, background will auto-detect from the page.
  // If filled, use the manual value (overrides auto-detect).

  const ok = window.confirm(
    `确定要批量删除 X 账号 @${u || '(自动识别)'} 的所有回复吗?\n\n` +
    `此操作不可恢复(虽然 X 会给 30 秒 Undo 提示)。\n\n` +
    `建议先用 2.0s 或更慢的速度,首次使用建议先在备用账号试。\n\n` +
    `继续吗?`
  );
  if (!ok) return;

  const rateMs = parseInt(ui.rate.value, 10) || 2000;
  forward('START_CLEAN', { username: u, rateMs, jitterMs: Math.round(rateMs * 0.25) })
    .then((r) => {
      if (!r || !r.ok) {
        setError((r && r.error) || '启动失败');
      } else if (r.username && r.username !== u) {
        // Background auto-detected a different username than the field
        ui.username.value = r.username;
        ui.usernameHint.textContent = '🔍 已自动识别: @' + r.username;
        ui.usernameHint.className = 'hint ok';
      }
    });
}

ui.startBtn.addEventListener('click', validateAndStart);
ui.username.addEventListener('input', () => {
  ui.username.dataset.auto = '0';
  if (ui.username.value) {
    ui.usernameHint.textContent = '✏️ 手动输入';
    ui.usernameHint.className = 'hint';
  } else {
    ui.usernameHint.textContent = '留空 = 自动识别';
    ui.usernameHint.className = 'hint';
  }
  refreshButtons();
});

ui.pauseBtn.addEventListener('click',  () => controlWith('PAUSE',  '⏸ 暂停中…',  '⏸ 暂停'));
ui.resumeBtn.addEventListener('click', () => controlWith('RESUME', '▶ 继续中…',  '▶ 继续'));
ui.stopBtn.addEventListener('click',   () => controlWith('STOP',   '⏹ 停止中…',  '⏹ 停止'));

// Optimistic UI: change the button text immediately, revert if it fails.
async function controlWith(kind, pendingText, restoreText) {
  // Find which button was clicked
  const btn = (kind === 'PAUSE' ? ui.pauseBtn :
               kind === 'RESUME' ? ui.resumeBtn :
               ui.stopBtn);
  if (!activeTabId) { setError('请先点击"定位当前页面"。'); return; }

  const original = btn.textContent;
  btn.textContent = pendingText;
  btn.disabled = true;
  setError('');
  setInfo('→ ' + kind + ' 发送中…');

  try {
    const r = await forward(kind);
    if (!r || !r.ok) {
      setError((kind + ' 失败: ' + (r && r.error || '未知错误')));
      btn.textContent = original;
    } else {
      setInfo('✓ ' + kind + ' 已送达');
      // Don't restore the text — refreshButtons will re-render based on status
    }
  } catch (e) {
    setError(kind + ' 异常: ' + e);
    btn.textContent = original;
  } finally {
    btn.disabled = false;
    // Force a status poll to update the buttons
    setTimeout(() => bgGetStatus().then(applyStatus), 100);
  }
}

// ----------------------------------------------------------------
// Copy diagnostic info to clipboard
// ----------------------------------------------------------------
ui.diagBtn.addEventListener('click', async () => {
  const lines = [
    '=== Twitter Reply Cleaner Diagnostic ===',
    'Extension version: ' + (chrome.runtime.getManifest().version),
    'Time: ' + new Date().toISOString(),
    'Last cached status: ' + JSON.stringify(lastStatus),
    ''
  ];

  // 1) Always try to find an X tab, even if activeTabId is null
  const findR = await bgFindTab();
  if (findR && findR.tab) {
    lines.push('--- Found X tab(s) ---');
    lines.push('Selected: id=' + findR.tab.id + '  url=' + findR.tab.url);
    if (findR.allTabs && findR.allTabs.length > 1) {
      lines.push('All X tabs (' + findR.allTabs.length + '):');
      findR.allTabs.forEach((t, i) =>
        lines.push('  [' + i + '] id=' + t.id + '  url=' + t.url));
    }
    // Save it for later
    activeTabId = findR.tab.id;

    // 2) Ping the tab
    const r = await bgPingTab(findR.tab.id);
    if (r && r.ok && r.response) {
      const p = r.response;
      lines.push('');
      lines.push('--- Content script state ---');
      lines.push('URL: ' + p.url);
      lines.push('Logged in: ' + p.loggedIn);
      lines.push('On /with_replies page: ' + p.onRepliesPage);
      lines.push('Auto-detected username: ' + (p.loggedInUsername || '(not detected)'));
      lines.push('Running: ' + p.running + '  Paused: ' + p.paused + '  Deleted: ' + p.deleted);
      if (p.detectionLog) {
        lines.push('');
        lines.push('--- Detection attempts ---');
        for (const a of p.detectionLog) {
          lines.push('  ' + a.strategy + ' → ' + (a.hit || 'miss') + (a.href ? '  (href=' + a.href + ')' : ''));
        }
      }
    } else {
      lines.push('');
      lines.push('--- Content script NOT reachable ---');
      lines.push('Error: ' + (r && r.error || 'unknown'));
      lines.push('Try: refresh the X page, then click this button again.');
    }
  } else {
    lines.push('--- No X.com tab found ---');
    lines.push('Make sure you have https://x.com open in a tab.');
    lines.push('If in incognito, enable the extension in chrome://extensions > Details > Allow in incognito.');
  }

  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    const old = ui.diagBtn.textContent;
    ui.diagBtn.textContent = '✓ 已复制,粘贴给我看';
    setTimeout(() => { ui.diagBtn.textContent = old; }, 2000);
  } catch (e) {
    // Fallback: open a window with the text
    window.open('data:text/plain;charset=utf-8,' + encodeURIComponent(text), '_blank');
  }
});

// ----------------------------------------------------------------
// Poll status from background
// ----------------------------------------------------------------
function pollOnce() {
  // Prefer live state from content script (fresh, not cached in background)
  if (activeTabId) {
    bgPingTab(activeTabId).then(r => {
      if (r && r.ok && r.response) {
        const p = r.response;
        applyStatus({
          deleted: p.deleted || 0,
          running: !!p.running,
          paused: !!p.paused,
          currentPreview: p.currentPreview || '',
          type: p.running ? (p.paused ? 'paused' : 'working') : 'idle'
        });
        if (p.pageStats) setPageStats(p.pageStats);
      }
    });
  } else {
    bgGetStatus().then(s => {
      if (s && s.updatedAt) applyStatus(s);
    });
  }
}
function startPolling() {
  if (pollTimer) return;
  pollOnce();
  pollTimer = setInterval(pollOnce, 700);
}

// ----------------------------------------------------------------
// Auto-locate on popup open: find any X tab, inject content script,
// auto-fill username — so the user doesn't have to click 📍 every time
// ----------------------------------------------------------------
async function autoLocate() {
  const findR = await bgFindTab();
  if (!findR || !findR.tab) {
    ui.usernameHint.textContent = '未找到 X 页面 — 请打开 https://x.com';
    ui.usernameHint.className = 'hint bad';
    return;
  }
  activeTabId = findR.tab.id;
  const pingR = await bgPingTab(activeTabId);
  if (!pingR || !pingR.ok || !pingR.response) return;
  const p = pingR.response;

  // Auto-fill username
  if (p.loggedInUsername && !ui.username.value) {
    ui.username.value = p.loggedInUsername;
    ui.username.dataset.auto = '1';
    ui.usernameHint.textContent = '🔍 已自动识别: @' + p.loggedInUsername + (p.onRepliesPage ? ' (已在回复页)' : '');
    ui.usernameHint.className = 'hint ok';
  } else if (!ui.username.value) {
    ui.usernameHint.textContent = '⚠ 未自动识别 — 请手动填写';
    ui.usernameHint.className = 'hint bad';
  }

  // Apply fresh state
  if (p.snapshot) {
    applyStatus({
      deleted: p.snapshot.deleted || 0,
      running: !!p.snapshot.running,
      paused: !!p.snapshot.paused,
      currentPreview: p.snapshot.currentPreview || '',
      type: p.snapshot.running ? (p.snapshot.paused ? 'paused' : 'working') : 'idle'
    });
  } else {
    refreshButtons();
  }

  // Page stats: how many replies the script can see right now
  if (p.pageStats) setPageStats(p.pageStats);
}

startPolling();
seedStatus();
autoLocate();
refreshButtons();
