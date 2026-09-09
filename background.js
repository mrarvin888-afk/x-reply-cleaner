// Twitter Reply Cleaner - Service Worker
// Routes messages between popup and content script.
// Key responsibilities:
//   1. Find an existing X tab OR auto-inject content script on demand
//   2. Navigate to /{username}/with_replies when starting a clean
//   3. Aggregate status for the popup to poll

const lastStatus = {
  type: 'idle',
  running: false,
  deleted: 0,
  paused: false,
  currentPreview: '',
  warning: '',
  error: '',
  updatedAt: 0,
  tabId: null
};

// ----------------------------------------------------------------
// Inject content.js into an existing tab that doesn't have it yet
// ----------------------------------------------------------------
async function ensureContentScript(tabId) {
  if (!tabId) return { ok: false, error: '缺少 tabId' };

  // 1) Try to ping first
  try {
    const r = await chrome.tabs.sendMessage(tabId, { kind: 'PING' });
    return { ok: true, response: r, injected: false };
  } catch (_) {
    // not present yet, fall through to inject
  }

  // 2) Inject content.js (it will register chrome.runtime.onMessage)
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  } catch (e) {
    return { ok: false, error: '无法注入到该页面: ' + (e.message || e) + '。请确认页面是 x.com / twitter.com 且已登录。' };
  }

  // 3) Wait a tick for the listener to register, then re-ping
  await new Promise(r => setTimeout(r, 350));
  try {
    const r = await chrome.tabs.sendMessage(tabId, { kind: 'PING' });
    return { ok: true, response: r, injected: true };
  } catch (e) {
    return { ok: false, error: '注入后仍无法连接: ' + (e.message || e) };
  }
}

// ----------------------------------------------------------------
// Navigate a tab and resolve when the new page finishes loading
// ----------------------------------------------------------------
function navigateAndWait(tabId, url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      err ? reject(err) : resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        // Small grace period for content script to load
        setTimeout(() => finish(), 500);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch(finish);
    setTimeout(() => finish(new Error('导航超时')), timeoutMs);
  });
}

// ----------------------------------------------------------------
// Message router
// ----------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.kind) return;

  // Content script pushed a status update
  if (msg.kind === 'CONTENT_STATUS') {
    Object.assign(lastStatus, msg.payload, { updatedAt: Date.now(), tabId: sender.tab?.id });
    return false;
  }

  // Popup polling for status
  if (msg.kind === 'GET_STATUS') {
    sendResponse(lastStatus);
    return false;
  }

  // Find a suitable X tab (prefers one already on /with_replies)
  if (msg.kind === 'FIND_TAB') {
    (async () => {
      const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
      const onReplies = tabs.find(t => {
        try { return /\/(with_replies|replies)$/.test(new URL(t.url).pathname); }
        catch { return false; }
      });
      sendResponse({
        tab: onReplies || tabs[0] || null,
        allTabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title }))
      });
    })();
    return true;
  }

  // Locate the tab AND ensure content script is injected
  if (msg.kind === 'PING_TAB') {
    (async () => {
      const r = await ensureContentScript(msg.tabId);
      sendResponse(r);
    })();
    return true;
  }

  // Start a cleaning run: ensure injection, navigate if needed, then start
  if (msg.kind === 'START_CLEAN') {
    (async () => {
      try {
        // 1) Make sure the content script is alive
        await ensureContentScript(msg.tabId);

        // 2) Resolve username (auto-detect from the page if not provided)
        let username = msg.username;
        if (!username) {
          const ping = await chrome.tabs.sendMessage(msg.tabId, { kind: 'PING' });
          username = ping && ping.loggedInUsername;
          if (!username) {
            sendResponse({ ok: false, error: '无法自动识别当前登录的用户名,请在弹出面板中手动填写。' });
            return;
          }
        }

        // 3) Navigate to /{username}/with_replies if not already there
        const tab = await chrome.tabs.get(msg.tabId);
        const path = new URL(tab.url).pathname;
        const onReplies = path.startsWith(`/${username}`) &&
                          /\/(with_replies|replies)$/.test(path);
        if (!onReplies) {
          const target = `https://x.com/${username}/with_replies`;
          await navigateAndWait(msg.tabId, target);
          await ensureContentScript(msg.tabId);
        }

        // 4) Hand off to the content script
        const resp = await chrome.tabs.sendMessage(msg.tabId, {
          kind: 'START_CLEAN',
          username,
          rateMs: msg.rateMs,
          jitterMs: msg.jitterMs
        });
        if (!resp || !resp.ok) {
          sendResponse({ ok: false, error: (resp && resp.error) || '页面拒绝启动删除任务。' });
          return;
        }
        sendResponse({ ok: true, response: resp, username });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }

  // Simple forwards: PAUSE / RESUME / STOP
  const SIMPLE = new Set(['PAUSE', 'RESUME', 'STOP']);
  if (SIMPLE.has(msg.kind)) {
    (async () => {
      try {
        const resp = await chrome.tabs.sendMessage(msg.tabId, msg);
        sendResponse({ ok: true, response: resp });
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[ReplyCleaner] installed');
});
