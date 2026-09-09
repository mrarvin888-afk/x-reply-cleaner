// Twitter Reply Cleaner - Content Script
// Runs on x.com / twitter.com. Identifies reply tweets and deletes them.
// Assumes the page is already on /{username}/with_replies (background.js handles navigation).

const state = {
  running: false,
  paused: false,
  stopping: false,
  rateMs: 2000,
  jitterMs: 500,
  deletedIds: new Set(),
  totalDeleted: 0,
  lastTweetText: '',
  username: ''
};

// Cached detected username (filled in async by side-bar scanner)
let detectedUsername = null;
const detectionLog = []; // diagnostic log of strategies tried

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Sleep that aborts early on pause/stop (polls every 80ms)
async function interruptibleSleep(ms) {
  const tick = 80;
  let elapsed = 0;
  while (elapsed < ms) {
    if (state.stopping || state.paused) return false; // aborted
    const wait = Math.min(tick, ms - elapsed);
    await sleep(wait);
    elapsed += wait;
  }
  return true; // completed
}
const rand  = (min, max) => Math.random() * (max - min) + min;
const log   = (...a) => console.log('[ReplyCleaner]', ...a);

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (state.stopping) return null;
    if (state.paused)   return null; // abort wait so the outer loop can pause
    try {
      const result = predicate();
      if (result) return result;
    } catch (e) { /* ignore */ }
    await sleep(intervalMs);
  }
  return null;
}

// ----------------------------------------------------------------
// Page checks
// ----------------------------------------------------------------
function isLoggedIn() {
  const txt = document.body ? document.body.innerText : '';
  if (txt.includes('Sign in to X') || txt.includes('Log in to Twitter')) return false;
  return !!document.querySelector(
    'a[href="/compose/post"], [data-testid="SideNav_NewTweet_Button"], [aria-label="Post"]'
  );
}

function onRepliesPage() {
  return /\/(with_replies|replies)$/.test(location.pathname);
}

// Detect the currently logged-in user (not whoever's profile we're viewing).
// Read the left sidebar / header profile link, so it works on any X page —
// including when viewing someone else's tweet detail.
// Returns { username, attempts } where attempts is a diagnostic log of what
// strategies were tried (useful for debugging).
function getLoggedInUsername() {
  const skip = new Set([
    'home', 'explore', 'notifications', 'messages', 'i', 'search', 'settings',
    'compose', 'share', 'intent', 'signup', 'login', 'account', 'i_flow',
    'bookmarks', 'communities', 'premium', 'jobs', 'lists', 'saved', 'topics',
    'moments', 'drafts', 'scheduled', 'about', 'tos', 'privacy', 'x'
  ]);
  const userRe = /^\/([a-zA-Z0-9_]{1,15})$/;
  const attempts = [];

  const tryOne = (label, href) => {
    const m = (href || '').match(userRe);
    const ok = !!(m && !skip.has(m[1]));
    attempts.push({ strategy: label, href: href || '', hit: ok ? m[1] : null });
    return ok ? m[1] : null;
  };

  // 1) Explicit "Profile" tab in the AppTabBar (X 2023-2024 stable)
  let el = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  if (el) {
    const u = tryOne('AppTabBar_Profile_Link', el.getAttribute('href'));
    if (u) return { username: u, attempts };
  }

  // 2) aria-label="Profile" link (X uses English aria-labels even on Chinese UI)
  el = document.querySelector('a[aria-label="Profile"][href^="/"]');
  if (el) {
    const u = tryOne('aria-label=Profile', el.getAttribute('href'));
    if (u) return { username: u, attempts };
  }

  // 3) Account switcher button — contains an avatar that links to the user
  el = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
  if (el) {
    const a = el.querySelector('a[href^="/"]');
    if (a) {
      const u = tryOne('SideNav_AccountSwitcher_Button → avatar link', a.getAttribute('href'));
      if (u) return { username: u, attempts };
    } else {
      attempts.push({ strategy: 'SideNav_AccountSwitcher_Button', hit: null, note: 'button found but no avatar link inside' });
    }
  }

  // 4) The "Post" / Compose area + its containing sidebar — find the sidebar,
  //    then look for the only single-segment href link that's not a known route
  //    (typically the Profile link is the only one)
  const headerEl = document.querySelector('header');
  if (headerEl) {
    const links = headerEl.querySelectorAll('a[href]');
    for (const link of links) {
      const m = (link.getAttribute('href') || '').match(userRe);
      if (m && !skip.has(m[1])) {
        const u = tryOne('header → first valid user-href', link.getAttribute('href'));
        if (u) return { username: u, attempts };
        break; // only test the first candidate
      }
    }
  }

  // 5) Any nav element on the page
  const navs = document.querySelectorAll('nav, [role="navigation"]');
  for (const nav of navs) {
    const links = nav.querySelectorAll('a[href]');
    for (const link of links) {
      const m = (link.getAttribute('href') || '').match(userRe);
      if (m && !skip.has(m[1])) {
        const u = tryOne(`nav[${nav.getAttribute('role') || nav.tagName}]`, link.getAttribute('href'));
        if (u) return { username: u, attempts };
        break;
      }
    }
  }

  // 6) Avatar link with UserAvatar testid
  const avatarLinks = document.querySelectorAll('a[data-testid^="UserAvatar-Container-"][href^="/"]');
  for (const link of avatarLinks) {
    const u = tryOne('UserAvatar-Container-*', link.getAttribute('href'));
    if (u) return { username: u, attempts };
    break;
  }

  // 7) Last resort: if URL itself is a profile page, use that
  const m = location.pathname.match(userRe);
  if (m && !skip.has(m[1])) {
    const u = tryOne('URL pathname', location.pathname);
    if (u) return { username: u, attempts };
  }

  return { username: null, attempts };
}

// Cache + retry: scan the page periodically for the first 30s, then settle.
function tryDetectAndCache() {
  if (detectedUsername) return detectedUsername;
  const r = getLoggedInUsername();
  if (r.username) {
    detectedUsername = r.username;
    log('✓ auto-detected username:', r.username);
    for (const a of r.attempts) {
      if (a.hit) log('  hit:', a.strategy, '→', a.hit);
    }
  } else {
    log('✗ username not detected, strategies tried:', r.attempts);
  }
  return detectedUsername;
}

// Watch the DOM for late-loading sidebar
const mo = new MutationObserver(() => {
  if (!detectedUsername) tryDetectAndCache();
});
try {
  mo.observe(document.documentElement, { childList: true, subtree: true });
} catch (e) { /* ignore */ }

// Periodic retry for the first 30s (sidebar often loads async)
let retryCount = 0;
const retryTimer = setInterval(() => {
  retryCount++;
  if (detectedUsername || retryCount > 15) {
    clearInterval(retryTimer);
    return;
  }
  tryDetectAndCache();
}, 2000);

// ----------------------------------------------------------------
// Tweet detection
// ----------------------------------------------------------------
function getTweetId(article) {
  if (!article) return null;
  const link = article.querySelector('a[href*="/status/"]');
  if (!link) return null;
  const m = (link.getAttribute('href') || '').match(/\/status\/(\d+)/);
  return m ? m[1] : null;
}

function getTweetText(article) {
  if (!article) return '';
  const t = article.querySelector('[data-testid="tweetText"]');
  if (!t) return '';
  return ((t.innerText || t.textContent || '').replace(/\s+/g, ' ').trim()).slice(0, 80);
}

function normalizeUsername(username) {
  return String(username || '').trim().replace(/^@/, '').toLowerCase();
}

function getTweetAuthor(article) {
  if (!article) return null;
  const links = article.querySelectorAll('a[href*="/status/"]');
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    const m = href.match(/^\/([a-zA-Z0-9_]{1,15})\/status\/\d+/);
    if (m) return m[1];
  }
  return null;
}

function isOwnedTweet(article, username = state.username || detectedUsername) {
  const wanted = normalizeUsername(username);
  const author = normalizeUsername(getTweetAuthor(article));
  return !!(wanted && author && wanted === author);
}

function hasReplyContext(article) {
  if (!article) return false;
  // X has used several different DOM shapes for this line.  In particular,
  // Chinese pages and conversation modules often omit data-testid.
  const replyText = /^(?:Replying\s+to|In\s+reply\s+to|正在回复|回复给|回复)\s*@/i;
  const social = article.querySelector('[data-testid="socialContext"]');
  if (social) {
    const txt = (social.textContent || '').replace(/\s+/g, ' ').trim();
    if (replyText.test(txt) || /^(?:Replying\s+to|正在回复|回复给)/i.test(txt)) return true;
  }

  // Inspect short text containers only. Avoid article.innerText because the
  // action bar itself contains words such as "Reply" / "回复".
  for (const el of article.querySelectorAll('a, span, div[dir="ltr"], div[dir="auto"]')) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length <= 160 && replyText.test(t)) return true;
  }
  return false;
}

function isReply(article, username = state.username || detectedUsername) {
  // Never act on a tweet unless its canonical status URL belongs to the
  // selected account. This is the hard safety gate that protects quoted/root
  // tweets belonging to other people.
  if (!isOwnedTweet(article, username)) return false;
  if (hasReplyContext(article)) return true;

  // Conversation cards (like the layout in the supplied screenshot) can
  // omit the reply label entirely. In those cards X places the root and its
  // replies in one cell; every article after the first is a reply. Keep this
  // fallback scoped to the same cell and still require the ownership gate.
  const cell = article.closest('[data-testid="cellInnerDiv"]');
  if (cell) {
    const cardArticles = Array.from(cell.querySelectorAll('article[data-testid="tweet"]'));
    const index = cardArticles.indexOf(article);
    if (index > 0) return true;
  }

  // On the profile's /with_replies timeline X may put each item in its own
  // cell. In that layout a reply is the next article immediately following a
  // different author's article (the screenshot's connected conversation
  // cards). Limit this to a small visual gap so unrelated timeline items are
  // not treated as replies.
  const all = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const pos = all.indexOf(article);
  if (pos > 0) {
    const previous = all[pos - 1];
    if (!isOwnedTweet(previous, username)) {
      const a = article.getBoundingClientRect();
      const b = previous.getBoundingClientRect();
      const gap = a.top - b.bottom;
      if (gap >= -8 && gap <= 140) return true;
    }
  }
  return false;
}

// ----------------------------------------------------------------
// UI helpers
// ----------------------------------------------------------------
function findMenuItemByText(text) {
  const wanted = String(text).toLowerCase();
  for (const item of document.querySelectorAll('[role="menuitem"]')) {
    const value = (item.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (value === wanted || value.startsWith(wanted + ' ')) return item;
  }
  return null;
}

function findDeleteMenuItem() {
  for (const item of document.querySelectorAll('[role="menuitem"]')) {
    const value = (item.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^(?:Delete(?: post)?|删除(?:帖子|推文)?)$/i.test(value)) return item;
  }
  return null;
}

function findConfirmButton() {
  // 1) Primary testid (X standard)
  let btn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
  if (btn) return btn;

  // 2) Fallback: any button in a sheet/dialog with destructive text
  const sheets = document.querySelectorAll(
    '[data-testid="sheetDialog"], [role="alertdialog"], [role="dialog"]'
  );
  for (const s of sheets) {
    const buttons = s.querySelectorAll('button');
    for (const b of buttons) {
      const t = (b.textContent || '').trim();
      if (/^(?:删除(?:帖子|推文)?|Delete(?: post)?)$/i.test(t)) {
        // The red "删除" in your screenshot is the destructive primary action
        // (X renders it last in the modal). Prefer the last match.
        btn = b;
      }
    }
    if (btn) return btn;
  }

  return null;
}

function findCaret(article) {
  return article.querySelector('[data-testid="caret"]') ||
         article.querySelector('button[aria-label="More"]') ||
         article.querySelector('[aria-label="More"]') ||
         article.querySelector('button[aria-label="更多"]') ||
         article.querySelector('[aria-label="更多"]');
}

function dismissAnyOpenMenu() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.body.click();
}

// ----------------------------------------------------------------
// Delete one reply
// ----------------------------------------------------------------
async function deleteOneReply() {
  if (state.stopping) return { success: false, reason: 'stopped' };
  if (state.paused)   return { success: false, reason: 'paused' };

  // Re-query each iteration - DOM mutates after each delete
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  let target = null;
  for (const a of articles) {
    if (!isReply(a, state.username)) continue;
    const id = getTweetId(a);
    if (!id || state.deletedIds.has(id)) continue;
    target = a;
    break;
  }
  if (!target) return { success: false, reason: 'no_reply_in_dom' };

  const id = getTweetId(target);
  const preview = getTweetText(target);
  state.lastTweetText = preview;

  // Bring into view
  try { target.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
  if (!(await interruptibleSleep(200))) return { success: false, reason: 'paused' };

  // Open caret menu
  const caret = findCaret(target);
  if (!caret) return { success: false, reason: 'no_caret', id, preview };
  caret.click();
  if (!(await interruptibleSleep(280))) return { success: false, reason: 'paused', id };

  if (state.stopping) return { success: false, reason: 'stopped', id };

  // Click "Delete" in menu
  const menuItem = await waitFor(
    () => findDeleteMenuItem() || findMenuItemByText('Delete') || findMenuItemByText('删除'),
    3000
  );
  if (!menuItem) {
    dismissAnyOpenMenu();
    if (state.paused) return { success: false, reason: 'paused', id, preview };
    return { success: false, reason: 'menu_item_not_found', id, preview };
  }
  menuItem.click();
  if (!(await interruptibleSleep(320))) return { success: false, reason: 'paused', id };

  if (state.stopping) return { success: false, reason: 'stopped', id };

  // Click confirmation
  const confirmBtn = await waitFor(() => findConfirmButton(), 4000);
  if (!confirmBtn) {
    dismissAnyOpenMenu();
    if (state.paused) return { success: false, reason: 'paused', id, preview };
    return { success: false, reason: 'confirm_not_found', id, preview };
  }
  confirmBtn.click();

  // Wait for removal (or for an interstitial sheet that blocks)
  const removed = await waitFor(() => {
    if (state.stopping) return true;
    if (state.paused)   return true;
    if (!document.contains(target)) return true;
    return !!document.querySelector('[data-testid="sheetDialog"]');
  }, 6000);

  if (!removed) {
    dismissAnyOpenMenu();
    if (state.paused) return { success: false, reason: 'paused', id, preview };
    return { success: false, reason: 'not_removed', id, preview };
  }

  if (state.paused) return { success: false, reason: 'paused', id, preview };

  state.deletedIds.add(id);
  state.totalDeleted++;
  return { success: true, id, preview };
}

// ----------------------------------------------------------------
// Scroll-to-load
// ----------------------------------------------------------------
async function scrollToLoadMore() {
  // X uses a virtualized timeline. Jumping straight to scrollHeight can
  // discard the visible cards before the next batch is mounted, and makes
  // the browser appear to teleport to the bottom. Advance by roughly one
  // viewport instead, then give X time to append the next batch.
  const beforeY = window.scrollY;
  const beforeHeight = document.documentElement.scrollHeight;
  const step = Math.max(420, Math.floor(window.innerHeight * 0.8));
  window.scrollBy({ top: step, left: 0, behavior: 'smooth' });
  await sleep(1200);
  const moved = window.scrollY > beforeY + 40;
  const grew = document.documentElement.scrollHeight > beforeHeight;
  return moved || grew;
}

// Inspect the current page: how many tweets, how many detected as replies,
// and a few sample texts. Used for diagnostic and the popup status.
function getPageStats() {
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const total = articles.length;
  const replies = [];
  const samples = [];
  for (const a of articles) {
    if (isReply(a, state.username || detectedUsername)) {
      const id = getTweetId(a);
      const txt = getTweetText(a);
      if (id) replies.push({ id, text: txt });
      if (samples.length < 3 && txt) samples.push(txt);
    }
  }
  const ownedCount = articles.filter(a => isOwnedTweet(a, state.username || detectedUsername)).length;
  return { total, ownedCount, replyCount: replies.length, samples };
}

// ----------------------------------------------------------------
// Status reporting
// ----------------------------------------------------------------
function snapshot() {
  return {
    type: state.running ? (state.paused ? 'paused' : 'working') : 'idle',
    running: state.running,
    deleted: state.totalDeleted,
    paused: state.paused,
    currentPreview: state.lastTweetText,
    lastError: state.lastError || ''
  };
}

function sendStatus(type, extra = {}) {
  const payload = {
    type,
    running: state.running,
    deleted: state.totalDeleted,
    paused: state.paused,
    currentPreview: state.lastTweetText,
    ...extra
  };
  try {
    chrome.runtime.sendMessage({ kind: 'CONTENT_STATUS', payload });
    // Also persist in storage.session so count survives SW restart / popup reopen
    chrome.storage.session.set({
      cleaner_state: {
        deleted: state.totalDeleted,
        running: state.running,
        paused: state.paused,
        currentPreview: state.lastTweetText,
        lastType: type,
        updatedAt: Date.now()
      }
    });
  } catch (e) { /* storage or runtime gone */ }
}

// ----------------------------------------------------------------
// Main loop
// ----------------------------------------------------------------
async function runCleanerLoop() {
  state.running = true;
  state.paused = false;
  state.stopping = false;
  state.deletedIds = new Set();
  state.totalDeleted = 0;

  sendStatus('starting');

  if (!isLoggedIn()) {
    sendStatus('error', { fatal: true, message: '未登录 X / Twitter。请先在浏览器中登录。' });
    state.running = false;
    return;
  }
  if (!onRepliesPage()) {
    sendStatus('error', { fatal: true, message: '当前页面不是 /with_replies。请重新点击"开始删除",扩展会自动跳转。' });
    state.running = false;
    return;
  }

  let idleRounds = 0;
  let consecutiveFailures = 0;

  while (!state.stopping) {
    while (state.paused && !state.stopping) {
      sendStatus('paused');
      await sleep(500);
    }
    if (state.stopping) break;

    sendStatus('working', { currentPreview: state.lastTweetText });

    let res;
    try {
      res = await deleteOneReply();
    } catch (e) {
      log('deleteOneReply threw:', e);
      res = { success: false, reason: 'exception', error: String(e) };
    }

    if (state.stopping) break;

    if (res.success) {
      consecutiveFailures = 0;
      idleRounds = 0;
      sendStatus('progress', {
        deleted: state.totalDeleted,
        currentPreview: res.preview
      });
      const delay = state.rateMs + rand(-state.jitterMs, state.jitterMs);
      await interruptibleSleep(delay);
    } else if (res.reason === 'paused') {
      // Pause signal — outer while-loop will catch it next iteration
      await interruptibleSleep(50);
      continue;
    } else {
      consecutiveFailures++;
      if (res.reason === 'no_reply_in_dom') {
        const loaded = await scrollToLoadMore();
        idleRounds = loaded ? 0 : idleRounds + 1;
        if (idleRounds >= 3) {
          sendStatus('done', { deleted: state.totalDeleted, reason: 'no_more_replies' });
          break;
        }
      } else if (consecutiveFailures >= 5) {
        sendStatus('error', {
          fatal: true,
          message: `连续 ${consecutiveFailures} 次失败 (${res.reason})。已自动停止,可能是 X 改了页面结构或触发了限流。`,
          lastReason: res.reason
        });
        break;
      } else {
        log('Failure:', res.reason, 'id:', res.id);
        sendStatus('progress', {
          deleted: state.totalDeleted,
          currentPreview: res.preview || state.lastTweetText,
          warning: res.reason
        });
        await sleep(state.rateMs * 1.5);
      }
    }
  }

  state.running = false;
  if (state.stopping) {
    sendStatus('stopped', { deleted: state.totalDeleted });
  }
}

// ----------------------------------------------------------------
// Message handling
// ----------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.kind) return;

  switch (msg.kind) {
    case 'PING': {
      // Trigger a fresh detection attempt on every PING
      const det = tryDetectAndCache();
      const stats = getPageStats();
      sendResponse({
        ok: true,
        url: location.href,
        loggedIn: isLoggedIn(),
        onRepliesPage: onRepliesPage(),
        running: state.running,
        paused: state.paused,
        deleted: state.totalDeleted,
        currentPreview: state.lastTweetText,
        loggedInUsername: det,
        detectionLog: det ? null : getLoggedInUsername().attempts,
        pageStats: stats,
        snapshot: snapshot()
      });
      return false;
    }

    case 'START_CLEAN': {
      if (state.running) {
        sendResponse({ ok: false, error: '已经在运行' });
        return false;
      }
      let username = msg.username || detectedUsername || (tryDetectAndCache());
      if (!username) {
        const r = getLoggedInUsername();
        sendResponse({
          ok: false,
          error: '无法自动识别当前登录用户,请在弹出面板中手动填写。\n诊断: ' +
            r.attempts.map(a => `${a.strategy}=${a.hit || 'miss'}`).join('; ')
        });
        return false;
      }
      state.username = username;
      state.rateMs   = msg.rateMs   || 2000;
      state.jitterMs = msg.jitterMs || 500;
      sendResponse({ ok: true, username });
      runCleanerLoop();
      return false;
    }

    case 'PAUSE': {
      if (state.running) {
        state.paused = true;
        log('PAUSE received, deleting=' + state.totalDeleted);
        sendStatus('paused', { deleted: state.totalDeleted });  // push status immediately
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: '未在运行' });
      }
      return false;
    }
    case 'RESUME': {
      if (state.running) {
        state.paused = false;
        log('RESUME received');
        sendStatus('working', { deleted: state.totalDeleted, currentPreview: state.lastTweetText });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: '未在运行' });
      }
      return false;
    }
    case 'STOP': {
      log('STOP received, deleting=' + state.totalDeleted);
      state.stopping = true;
      state.paused = false;
      sendResponse({ ok: true });
      return false;
    }
  }
});

log('content script loaded on', location.href);
