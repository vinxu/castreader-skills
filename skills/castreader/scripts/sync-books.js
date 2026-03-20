#!/usr/bin/env node

/**
 * sync-books.js — Sync books from Kindle or WeRead to local library
 *
 * Usage:
 *   node scripts/sync-books.js kindle              # Sync all Kindle books
 *   node scripts/sync-books.js kindle --max 3      # Sync at most 3 books
 *   node scripts/sync-books.js kindle --list        # List books without syncing (JSON)
 *   node scripts/sync-books.js kindle --book "书名"  # Sync only the matching book
 *   node scripts/sync-books.js weread               # Sync from WeRead
 *
 * For Kindle: opens each book in the reader, triggers OCR sync, then returns
 * to the library page. Each book takes several minutes depending on length.
 *
 * Environment variables:
 *   CASTREADER_EXT_PATH — Path to built extension
 *   CHROME_PROFILE      — Chrome user data dir
 */

const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const os = require('os');

const READOUT_DESKTOP = path.resolve(os.homedir(), 'Documents/MyProject/readout-desktop');
const BUNDLED_EXT_PATH = path.resolve(__dirname, '../chrome-extension');
const DEV_EXT_PATH = path.join(READOUT_DESKTOP, '.output/chrome-mv3');
const CHROME_PROFILE = process.env.CHROME_PROFILE || path.resolve(__dirname, '../.chrome-profile');
const SYNC_SERVER_PORT = 18790;
const SYNC_SERVER_SCRIPT = path.resolve(__dirname, 'sync-server.cjs');
const LIBRARY_PATH = path.join(os.homedir(), 'castreader-library');

// Lazy-loaded puppeteer (installed on demand)
let puppeteer;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Sync Server ----

function startSyncServer() {
  if (!fs.existsSync(SYNC_SERVER_SCRIPT)) {
    console.error(`Error: sync-server.cjs not found at ${SYNC_SERVER_SCRIPT}`);
    process.exit(1);
  }
  const child = spawn('node', [SYNC_SERVER_SCRIPT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  child.stdout.on('data', (d) => process.stderr.write(`[sync-server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[sync-server] ${d}`));
  return child;
}

async function waitForSyncServer(maxAttempts = 15) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${SYNC_SERVER_PORT}/health`);
      if (res.ok) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

async function getBookCount() {
  try {
    const res = await fetch(`http://127.0.0.1:${SYNC_SERVER_PORT}/list-books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.ok) {
      const data = await res.json();
      return data.books ? data.books.length : 0;
    }
  } catch {}
  return 0;
}

async function getSyncedBookTitles() {
  try {
    const res = await fetch(`http://127.0.0.1:${SYNC_SERVER_PORT}/list-books`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.ok) {
      const data = await res.json();
      return (data.books || []).map((b) => b.title || '');
    }
  } catch {}
  // Fallback: read from local index.json
  try {
    const indexPath = path.join(LIBRARY_PATH, 'index.json');
    if (fs.existsSync(indexPath)) {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      return (index.books || []).map((b) => b.title || '');
    }
  } catch {}
  return [];
}

// ---- Auto-setup ----

function ensureDependencies() {
  // Ensure puppeteer is installed in skill directory
  const skillDir = path.resolve(__dirname, '..');
  const puppeteerPath = path.join(skillDir, 'node_modules', 'puppeteer');
  if (!fs.existsSync(puppeteerPath)) {
    process.stderr.write('Installing dependencies (first run)...\n');
    execSync('npm install --silent 2>/dev/null', { cwd: skillDir, stdio: 'inherit' });
  }
  puppeteer = require('puppeteer');
}

const EXTENSION_REPO = 'https://github.com/vinxu/castreader-extension.git';

function ensureExtensionBuilt() {
  // Priority: env var > dev build > bundled > download from GitHub > build from source
  if (process.env.CASTREADER_EXT_PATH) {
    const p = process.env.CASTREADER_EXT_PATH;
    if (fs.existsSync(path.join(p, 'manifest.json'))) return p;
    console.error(`Error: Extension not found at ${p}`);
    process.exit(1);
  }

  // Dev build (latest, if readout-desktop project exists)
  if (fs.existsSync(path.join(DEV_EXT_PATH, 'manifest.json'))) {
    process.stderr.write('Using dev extension build.\n');
    return DEV_EXT_PATH;
  }

  // Bundled extension (shipped with skill or previously downloaded)
  if (fs.existsSync(path.join(BUNDLED_EXT_PATH, 'manifest.json'))) {
    process.stderr.write('Using bundled extension.\n');
    return BUNDLED_EXT_PATH;
  }

  // Download from GitHub (extension not bundled with skill to keep package small)
  process.stderr.write('Extension not found locally. Downloading from GitHub...\n');
  try {
    execSync(`git clone --depth 1 ${EXTENSION_REPO} "${BUNDLED_EXT_PATH}"`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Remove .git dir to save space
    const gitDir = path.join(BUNDLED_EXT_PATH, '.git');
    if (fs.existsSync(gitDir)) {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }
    if (fs.existsSync(path.join(BUNDLED_EXT_PATH, 'manifest.json'))) {
      process.stderr.write('Extension downloaded successfully.\n');
      return BUNDLED_EXT_PATH;
    }
  } catch (e) {
    process.stderr.write(`Download failed: ${e.message}\n`);
  }

  // Fallback: try building from source
  if (fs.existsSync(READOUT_DESKTOP)) {
    process.stderr.write('Building extension from source...\n');
    const nodeModules = path.join(READOUT_DESKTOP, 'node_modules');
    if (!fs.existsSync(nodeModules)) {
      execSync('pnpm install', { cwd: READOUT_DESKTOP, stdio: 'inherit' });
    }
    execSync('pnpm build', { cwd: READOUT_DESKTOP, stdio: 'inherit' });
    if (fs.existsSync(path.join(DEV_EXT_PATH, 'manifest.json'))) {
      return DEV_EXT_PATH;
    }
  }

  console.error('Error: Chrome extension not found.');
  console.error('Try: git clone https://github.com/vinxu/castreader-extension.git chrome-extension');
  process.exit(1);
}

// ---- Chrome ----

async function launchChrome(extPath) {
  process.stderr.write(`Launching Chrome with extension from ${extPath}...\n`);
  return puppeteer.launch({
    headless: false,
    protocolTimeout: 600_000,
    ignoreDefaultArgs: ['--disable-extensions', '--enable-automation'],
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--disable-blink-features=AutomationControlled',
    ],
    userDataDir: CHROME_PROFILE,
  });
}

async function findExtensionId(browser) {
  for (let attempt = 0; attempt < 15; attempt++) {
    await sleep(1000);
    const targets = browser.targets();
    // Look for any target with chrome-extension:// URL (SW, page, or other)
    for (const t of targets) {
      const url = t.url();
      if (url.includes('chrome-extension://')) {
        const match = url.match(/chrome-extension:\/\/([a-z]+)\//);
        if (match) return match[1];
      }
    }
    // After a few attempts, try navigating a page to wake extension
    if (attempt === 5) {
      const pages = await browser.pages();
      if (pages.length > 0) {
        // Reload a page to trigger extension content script → wakes SW
        await pages[0].reload({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      }
    }
  }
  throw new Error('Could not find CastReader extension ID');
}

// ---- Service Worker ----

async function findServiceWorker(browser, extId) {
  const checkSW = () => {
    return browser.targets().find(
      (t) => t.type() === 'service_worker' && t.url().includes(`chrome-extension://${extId}/`),
    );
  };

  // Wait up to 30s for SW to appear naturally (content script triggers it)
  for (let i = 0; i < 15; i++) {
    const sw = checkSW();
    if (sw) return sw;
    if (i === 0) process.stderr.write('  Waiting for service worker...\n');
    await sleep(2000);
  }
  return null;
}

/**
 * Send a message to the content script on the given page.
 * Strategy: find the extension's content script execution context via CDP
 * and call chrome.runtime.sendMessage directly — no SW dependency.
 */
/**
 * Send message to content script via background SW.
 * The page parameter is used to reload and wake the SW if it's dormant.
 */
async function sendMessageToActiveTab(browser, extId, message, page) {
  const msgJson = JSON.stringify(message);

  const trySendViaSW = async () => {
    const swTarget = await findServiceWorker(browser, extId);
    if (!swTarget) return null;

    const swCdp = await swTarget.createCDPSession();
    try {
      await swCdp.send('Runtime.enable');
      const { result, exceptionDetails } = await swCdp.send('Runtime.evaluate', {
        expression: `
          (async () => {
            const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            if (!activeTab || !activeTab.id) {
              return JSON.stringify({ success: false, error: 'No active tab found' });
            }
            try {
              const response = await chrome.tabs.sendMessage(activeTab.id, ${msgJson});
              return JSON.stringify({ success: true, tabId: activeTab.id, response });
            } catch (e) {
              // Content script not loaded — inject it
              try {
                await chrome.scripting.executeScript({
                  target: { tabId: activeTab.id },
                  files: ['content-scripts/content.js'],
                });
                await new Promise(r => setTimeout(r, 3000));
                const response = await chrome.tabs.sendMessage(activeTab.id, ${msgJson});
                return JSON.stringify({ success: true, tabId: activeTab.id, response, injected: true });
              } catch (e2) {
                return JSON.stringify({ success: false, tabId: activeTab.id, error: e2.message });
              }
            }
          })()
        `,
        awaitPromise: true,
        returnByValue: true,
      });

      if (exceptionDetails) {
        return { success: false, error: exceptionDetails.text };
      }
      try { return JSON.parse(result.value); } catch { return { success: true, raw: result.value }; }
    } finally {
      await swCdp.detach();
    }
  };

  // Try once
  const first = await trySendViaSW();
  if (first && first.success) return first;

  // SW not found — reload the page to wake content script → SW
  if (page && (!first || first.error?.includes('not found'))) {
    process.stderr.write('  Reloading page to wake extension...\n');
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(5000);
    await page.bringToFront();

    const second = await trySendViaSW();
    if (second) return second;
  }

  return first || { success: false, error: 'Background service worker not found' };
}

/**
 * Poll SYNC_LIBRARY_STATUS until sync is done or errored.
 */
async function waitForSyncComplete(browser, extId, bookTitle, page, timeoutMs = 30 * 60 * 1000) {
  const start = Date.now();
  let lastMsg = '';

  while (Date.now() - start < timeoutMs) {
    await sleep(5000);

    const statusResult = await sendMessageToActiveTab(browser, extId, { type: 'SYNC_LIBRARY_STATUS' }, page);
    if (!statusResult.success) {
      process.stderr.write(`  Status check failed: ${statusResult.error}\n`);
      continue;
    }

    const resp = statusResult.response;
    if (!resp) continue;

    const progress = resp.progress;
    if (progress) {
      const msg = `  [${bookTitle}] ${progress.status}: page ${progress.currentPage}/${progress.totalPages} (${progress.percent || 0}%)`;
      if (msg !== lastMsg) {
        process.stderr.write(msg + '\n');
        lastMsg = msg;
      }

      if (progress.status === 'done') return { success: true };
      if (progress.status === 'error') return { success: false, error: progress.message };
      if (progress.status === 'cancelled') return { success: false, error: 'cancelled' };
    }

    // If not syncing and no progress, sync may have finished silently
    if (resp.syncing === false && progress?.status === 'done') {
      return { success: true };
    }
  }

  return { success: false, error: 'timeout' };
}

// ---- Wait for login ----

function isLoginPage(url, source) {
  if (source === 'kindle') {
    return url.includes('/ap/signin') || url.includes('/ap/register') ||
           url.includes('read.amazon.com/landing') || url.includes('amazon.com/gp/sign-in');
  }
  if (source === 'weread') {
    return url.includes('login') || url.includes('passport.weread');
  }
  return false;
}

async function isWeReadLoggedIn(page) {
  // WeRead shows shelf even when not logged in — check for "登录" in nav
  const notLoggedIn = await page.evaluate(() => {
    const body = document.body?.innerText || '';
    // Check for login button in nav
    const els = document.querySelectorAll('a, span, div');
    for (const el of els) {
      if (el.textContent?.trim() === '登录' || el.textContent?.trim() === '登陆') {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return true;
      }
    }
    // Empty shelf with no avatar = not logged in
    if (body.length < 500 && body.includes('登录')) return true;
    return false;
  });
  return !notLoggedIn;
}

async function waitForWeReadQrCode(page, timeoutMs = 15000) {
  // Wait for QR code image to appear after clicking login button
  // WeRead login dialog: img.login_dialog_qrcode_img_main (200x200 base64 QR)
  const qrSelectors = [
    'img.login_dialog_qrcode_img_main',
    '.login_dialog_qrcode img',
    '.login_dialog_container img',
  ];

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    for (const sel of qrSelectors) {
      const el = await page.$(sel);
      if (el) {
        const visible = await el.evaluate(e => {
          const rect = e.getBoundingClientRect();
          return rect.width > 30 && rect.height > 30;
        });
        if (visible) {
          const screenshotPath = path.join(os.tmpdir(), `weread-qr-${Date.now()}.png`);
          await el.screenshot({ path: screenshotPath });
          return screenshotPath;
        }
      }
    }
    await sleep(500);
    process.stderr.write('.');
  }

  // Timeout — screenshot the login dialog or full page
  process.stderr.write('\n');
  const screenshotPath = path.join(os.tmpdir(), `weread-qr-${Date.now()}.png`);
  const dialog = await page.$('.login_dialog_container');
  if (dialog) {
    await dialog.screenshot({ path: screenshotPath });
  } else {
    await page.screenshot({ path: screenshotPath });
  }
  return screenshotPath;
}

async function waitForLogin(page, source) {
  const readyPatterns = {
    kindle: /read\.amazon\.com\/kindle-library/,
    weread: /weread\.qq\.com\/web\/shelf/,
  };
  const readyPattern = readyPatterns[source];
  const sourceNames = { kindle: 'Kindle Cloud Reader', weread: 'WeRead (微信读书)' };

  // Quick check — already on library page (saved login session)
  const initialUrl = page.url();
  if (readyPattern.test(initialUrl)) {
    // For WeRead, also check page content (shelf loads even when not logged in)
    if (source === 'weread') {
      const loggedIn = await isWeReadLoggedIn(page);
      if (!loggedIn) {
        process.stderr.write('WeRead shelf loaded but not logged in.\n');
        // Fall through to login wait — will capture QR below
      } else {
        process.stderr.write('Already logged in.\n');
        return true;
      }
    } else {
      process.stderr.write('Already logged in.\n');
      return true;
    }
  }

  // WeRead: capture QR code and emit event for Skill to send to user via Telegram
  if (source === 'weread') {
    // Click the login button to trigger the QR code dialog
    // Click the login button to trigger the QR code dialog
    const loginBtn = await page.$('button.navBar_link_Login, .navBar_link_Login');
    if (loginBtn) {
      await loginBtn.click();
      await sleep(1000);
    }

    // Wait for QR code to appear before capturing
    process.stderr.write('  等待二维码出现');
    const qrScreenshot = await waitForWeReadQrCode(page);
    const loginMsg = {
      event: 'wechat_qr',
      source: 'weread',
      screenshot: qrScreenshot,
      message: '请在微信中长按识别此二维码登录微信读书，登录后会自动开始同步。',
    };
    console.log(JSON.stringify(loginMsg));
    process.stderr.write(`\n🔑 WeRead 需要登录\n`);
    process.stderr.write(`  二维码已截图: ${qrScreenshot}\n`);
    process.stderr.write(`  等待登录完成...\n\n`);
  } else if (isLoginPage(initialUrl, source)) {
    const loginMsg = {
      event: 'login_required',
      source,
      message: `Please log in to ${sourceNames[source]} in the browser window that just opened. The sync will start automatically after you log in.`,
    };
    console.log(JSON.stringify(loginMsg));
    process.stderr.write(`\n🔑 Login required for ${sourceNames[source]}\n`);
    process.stderr.write(`  Please log in in the browser window.\n`);
    process.stderr.write(`  Waiting for login to complete...\n\n`);
  }

  // Poll for login completion — check both URL and page content
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    const currentUrl = page.url();
    if (readyPattern.test(currentUrl)) {
      if (source === 'weread') {
        const loggedIn = await isWeReadLoggedIn(page);
        if (!loggedIn) continue; // URL matches but still not logged in
      }
      console.log(JSON.stringify({ event: 'login_complete', source }));
      process.stderr.write('✓ Login successful!\n');
      return true;
    }
  }

  console.log(JSON.stringify({ event: 'login_timeout', source }));
  return false;
}

// ---- Kindle: scroll to load all books ----

async function scrollToLoadAllBooks(page) {
  let prevCount = 0;
  let stableRounds = 0;

  for (let i = 0; i < 30; i++) {
    const count = await page.evaluate(() => {
      // Book tiles are <a> elements that contain cover <img> from media-amazon.com
      return document.querySelectorAll('a img[src*="media-amazon.com/images"]').length;
    });

    if (count === prevCount) {
      stableRounds++;
      if (stableRounds >= 3) break; // no new books after 3 scrolls
    } else {
      process.stderr.write(`  Loaded ${count} books so far...\n`);
      prevCount = count;
      stableRounds = 0;
    }

    // Scroll to bottom to trigger lazy loading
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);
  }

  return prevCount;
}

// ---- Kindle: get book titles from library page ----

async function getKindleBookTitles(page) {
  return page.evaluate(() => {
    const books = [];
    // Each book tile is an <a> wrapping a cover image.
    // The parent container of each <a> also contains title + author text.
    // Structure: <a class="..."><img src="cover"/></a> with sibling/parent text nodes
    //
    // Approach: find all <a> that have a media-amazon.com cover img child.
    // Then get the title from the closest container's text content.
    const bookLinks = document.querySelectorAll('a');
    bookLinks.forEach((a, index) => {
      const img = a.querySelector('img[src*="media-amazon.com/images"]');
      if (!img) return;

      // Walk up to find the book tile container (usually a parent div that
      // holds both the cover link and the title/author text).
      // The tile's full text typically contains: "Title\nTitle\nAuthor"
      let container = a.parentElement;
      // Go up until we find a container with text content
      for (let i = 0; i < 3; i++) {
        if (container?.textContent?.trim()) break;
        container = container?.parentElement;
      }

      const fullText = container?.innerText?.trim() || '';
      // Title appears on the first line (may be repeated)
      const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
      const title = lines[0] || '';
      // Author is usually the last unique line
      const author = lines.length > 1 ? lines[lines.length - 1] : '';

      if (title) {
        books.push({ index, title, author });
      }
    });

    return books;
  });
}

// ---- Kindle: click a book tile by index to open it ----

async function clickKindleBook(page, bookIndex) {
  // Click the book's cover image link
  const clicked = await page.evaluate((idx) => {
    const bookLinks = document.querySelectorAll('a');
    let count = 0;
    for (const a of bookLinks) {
      const img = a.querySelector('img[src*="media-amazon.com/images"]');
      if (!img) continue;
      if (count === idx) {
        a.click();
        return true;
      }
      count++;
    }
    return false;
  }, bookIndex);

  if (!clicked) return false;

  // Wait for navigation to reader page
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const url = page.url();
    if (url.includes('asin=') || (url.includes('read.amazon.com') && !url.includes('kindle-library'))) {
      // Check for "Kindle App Is Required"
      await sleep(3000);
      const appRequired = await page.evaluate(() => {
        const body = document.body?.innerText || '';
        return body.includes('Kindle App Is Required') || body.includes('can only be opened using Kindle app');
      });
      if (appRequired) {
        process.stderr.write(`  Book requires Kindle app (not available in Cloud Reader), skipping.\n`);
        return false;
      }
      // Wait for reader to fully load
      await sleep(5000);
      return true;
    }
  }

  process.stderr.write(`  Book did not open after click, skipping.\n`);
  return false;
}

// ---- Main: Kindle flow ----

async function syncKindle(browser, extId, page, maxBooks, { listOnly = false, bookFilter = null } = {}) {
  // Wait for login on library page
  const loggedIn = await waitForLogin(page, 'kindle');
  if (!loggedIn) {
    console.error('Timed out waiting for login.');
    process.exit(1);
  }

  process.stderr.write('Logged in. Scanning book library...\n');
  await sleep(3000);

  // Scroll to load all books
  process.stderr.write('Scrolling to load all books...\n');
  await scrollToLoadAllBooks(page);
  // Scroll back to top
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(1000);

  // Get book list with titles
  const bookList = await getKindleBookTitles(page);
  process.stderr.write(`Found ${bookList.length} books in library.\n`);

  if (bookList.length === 0) {
    console.error('Could not detect any books on the library page.');
    process.exit(1);
  }

  // --list mode: output book list as JSON and return
  if (listOnly) {
    console.log(JSON.stringify({ books: bookList.map(b => ({ title: b.title, author: b.author })) }));
    return { booksSynced: 0, totalBooks: bookList.length, listOnly: true };
  }

  // Show first few books
  bookList.slice(0, 5).forEach((b, i) => {
    process.stderr.write(`  ${i + 1}. "${b.title}" — ${b.author}\n`);
  });
  if (bookList.length > 5) {
    process.stderr.write(`  ... and ${bookList.length - 5} more\n`);
  }

  // Get already-synced book titles for comparison
  const syncedTitles = await getSyncedBookTitles();
  const initialBookCount = await getBookCount();
  let booksSynced = 0;

  // We need to re-index after going back to library, because DOM is rebuilt.
  // So we track books by title, not by DOM index.
  const booksToSync = [];
  for (const book of bookList) {
    // --book filter: skip books that don't match
    if (bookFilter) {
      const filterLower = bookFilter.toLowerCase();
      const titleLower = book.title.toLowerCase();
      if (!titleLower.includes(filterLower) && !filterLower.includes(titleLower)) {
        continue;
      }
    }
    const alreadySynced = syncedTitles.some((synced) =>
      synced.toLowerCase().includes(book.title.toLowerCase().substring(0, 30)) ||
      book.title.toLowerCase().includes(synced.toLowerCase().substring(0, 30))
    );
    booksToSync.push({ ...book, alreadySynced });
  }

  if (bookFilter && booksToSync.length === 0) {
    process.stderr.write(`No book matching "${bookFilter}" found in library.\n`);
    return { booksSynced: 0, totalBooks: bookList.length };
  }

  const skippedCount = booksToSync.filter(b => b.alreadySynced).length;
  const pendingCount = booksToSync.filter(b => !b.alreadySynced).length;
  process.stderr.write(`\nAlready synced: ${skippedCount}, To sync: ${pendingCount}\n\n`);

  for (let i = 0; i < booksToSync.length; i++) {
    if (maxBooks && booksSynced >= maxBooks) break;

    const book = booksToSync[i];

    if (book.alreadySynced) {
      process.stderr.write(`[${i + 1}/${booksToSync.length}] Skipping "${book.title}" (already synced)\n`);
      continue;
    }

    process.stderr.write(`\n[${i + 1}/${booksToSync.length}] Syncing "${book.title}"...\n`);

    // Need to re-scan library DOM to find the correct index (DOM rebuilt after back-nav)
    const currentBooks = await getKindleBookTitles(page);
    const matchIdx = currentBooks.findIndex((b) =>
      b.title.toLowerCase() === book.title.toLowerCase()
    );

    if (matchIdx < 0) {
      // Try partial match
      const partialIdx = currentBooks.findIndex((b) =>
        b.title.toLowerCase().includes(book.title.toLowerCase().substring(0, 20)) ||
        book.title.toLowerCase().includes(b.title.toLowerCase().substring(0, 20))
      );
      if (partialIdx < 0) {
        process.stderr.write(`  Could not find "${book.title}" in current DOM, skipping.\n`);
        continue;
      }
      process.stderr.write(`  Matched as "${currentBooks[partialIdx].title}"\n`);
    }

    const clickIdx = matchIdx >= 0 ? matchIdx : 0;

    // Scroll the book tile into view
    await page.evaluate((idx) => {
      const bookLinks = document.querySelectorAll('a');
      let count = 0;
      for (const a of bookLinks) {
        const img = a.querySelector('img[src*="media-amazon.com/images"]');
        if (!img) continue;
        if (count === idx) {
          a.scrollIntoView({ behavior: 'instant', block: 'center' });
          return;
        }
        count++;
      }
    }, clickIdx);
    await sleep(500);

    // Click to open
    const opened = await clickKindleBook(page, clickIdx);
    if (!opened) {
      // Go back to library
      await page.goto('https://read.amazon.com/kindle-library', { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(5000);
      // Re-scroll to load all
      await scrollToLoadAllBooks(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(1000);
      continue;
    }

    // Bring page to front
    await page.bringToFront();

    // Trigger sync
    let triggered = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await sendMessageToActiveTab(browser, extId, { type: 'SYNC_LIBRARY_START' }, page);
      if (result.success) {
        triggered = true;
        break;
      }
      process.stderr.write(`  Trigger attempt ${attempt + 1} failed: ${result.error}\n`);
      await sleep(3000);
    }

    if (!triggered) {
      process.stderr.write(`  Could not trigger sync for "${book.title}", skipping.\n`);
      await page.goto('https://read.amazon.com/kindle-library', { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(5000);
      await scrollToLoadAllBooks(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(1000);
      continue;
    }

    // Wait for sync to complete
    process.stderr.write(`  Sync started. Waiting for completion...\n`);
    const syncResult = await waitForSyncComplete(browser, extId, book.title, page);

    if (syncResult.success) {
      booksSynced++;
      process.stderr.write(`  ✓ "${book.title}" synced successfully!\n`);
    } else {
      process.stderr.write(`  ✗ "${book.title}" sync failed: ${syncResult.error}\n`);
    }

    // Go back to library for next book
    if (!(maxBooks && booksSynced >= maxBooks)) {
      process.stderr.write('  Returning to library...\n');
      await page.goto('https://read.amazon.com/kindle-library', { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(5000);
      // Re-scroll to load all books (DOM is rebuilt)
      await scrollToLoadAllBooks(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(1000);
    }
  }

  const finalCount = await getBookCount();
  return { booksSynced, totalBooks: finalCount, booksAdded: finalCount - initialBookCount };
}

// ---- WeRead: get book list from shelf page ----

async function getWeReadBookList(page) {
  return page.evaluate(() => {
    const books = [];
    // WeRead shelf has book cards with cover images and titles
    // Try multiple selectors for different WeRead layouts
    const bookEls = document.querySelectorAll('.shelf_book, .book_item, [class*="shelfBook"], [class*="book_card"]');

    if (bookEls.length > 0) {
      bookEls.forEach((el, index) => {
        const titleEl = el.querySelector('[class*="title"], .book_title, h3, h4');
        const authorEl = el.querySelector('[class*="author"], .book_author');
        const linkEl = el.querySelector('a[href*="/web/reader/"]');
        const title = titleEl?.textContent?.trim() || '';
        const author = authorEl?.textContent?.trim() || '';
        const href = linkEl?.getAttribute('href') || '';
        const bookId = href.match(/\/web\/reader\/([^/?]+)/)?.[1] || '';
        if (title) {
          books.push({ index, title, author, bookId, href });
        }
      });
    }

    // Fallback: find all links to /web/reader/ with nearby text
    if (books.length === 0) {
      const links = document.querySelectorAll('a[href*="/web/reader/"]');
      links.forEach((a, index) => {
        const href = a.getAttribute('href') || '';
        const bookId = href.match(/\/web\/reader\/([^/?]+)/)?.[1] || '';
        // Get text from link or parent
        let container = a;
        for (let i = 0; i < 3; i++) {
          if (container.innerText?.trim()?.length > 2) break;
          container = container.parentElement;
        }
        const fullText = container?.innerText?.trim() || '';
        const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
        const title = lines[0] || '';
        const author = lines.length > 1 ? lines[lines.length - 1] : '';
        if (title && bookId) {
          books.push({ index, title, author, bookId, href });
        }
      });
    }

    // Fallback 2: extract from shelf DOM by looking at book covers + text
    if (books.length === 0) {
      const imgs = document.querySelectorAll('img[src*="wfqqreader"], img[src*="weread"], img[alt]');
      imgs.forEach((img, index) => {
        let container = img.parentElement;
        for (let i = 0; i < 4; i++) {
          if (container?.innerText?.trim()?.length > 5) break;
          container = container?.parentElement;
        }
        const fullText = container?.innerText?.trim() || '';
        const lines = fullText.split('\n').map(l => l.trim()).filter(Boolean);
        const title = lines[0] || img.alt || '';
        const author = lines.length > 1 ? lines[lines.length - 1] : '';
        // Try to find a link in the container
        const link = container?.querySelector('a[href*="/web/reader/"]');
        const href = link?.getAttribute('href') || '';
        const bookId = href.match(/\/web\/reader\/([^/?]+)/)?.[1] || '';
        if (title) {
          books.push({ index, title, author, bookId, href });
        }
      });
    }

    return books;
  });
}

// ---- WeRead: click a book to open reader ----

async function clickWeReadBook(page, bookId, bookTitle) {
  if (bookId) {
    // Navigate directly to reader URL
    const readerUrl = `https://weread.qq.com/web/reader/${bookId}`;
    process.stderr.write(`  Navigating to ${readerUrl}...\n`);
    await page.goto(readerUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 5000));
    return page.url().includes('/web/reader/');
  }

  // Fallback: click by title text
  const clicked = await page.evaluate((title) => {
    const els = document.querySelectorAll('a, [class*="book"]');
    for (const el of els) {
      if (el.textContent?.includes(title)) {
        el.click();
        return true;
      }
    }
    return false;
  }, bookTitle);

  if (!clicked) return false;

  // Wait for navigation to reader page
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (page.url().includes('/web/reader/')) {
      await new Promise(r => setTimeout(r, 5000));
      return true;
    }
  }
  return false;
}

// ---- WeRead: extract text from fillText layout data ----

/**
 * Read layout data from intercept's DOM attribute.
 * Returns array of text lines from all Canvas pages.
 */
async function readWeReadLayoutText(page) {
  return page.evaluate(() => {
    const raw = document.documentElement.getAttribute('data-castreader-wr-layout');
    if (!raw) return { lines: [], pageCount: 0 };
    try {
      const layout = JSON.parse(raw);
      const lines = [];
      const pageCount = layout.pages?.length || 0;
      for (const p of (layout.pages || [])) {
        for (const line of (p.lines || [])) {
          if (line.t && line.t.trim()) lines.push(line.t.trim());
        }
      }
      return { lines, pageCount };
    } catch { return { lines: [], pageCount: 0 }; }
  });
}

/**
 * Read chapter API data from intercept's DOM attribute.
 * Returns extracted paragraphs from the API response.
 */
async function readWeReadChapterData(page) {
  return page.evaluate(() => {
    const raw = document.documentElement.getAttribute('data-castreader-wr-chapter');
    if (!raw) return [];
    const colonIdx = raw.indexOf(':');
    if (colonIdx <= 0) return [];
    try {
      const jsonStr = raw.substring(colonIdx + 1);
      const firstChar = jsonStr.charAt(0);
      if (firstChar !== '{' && firstChar !== '[') return []; // encrypted
      const data = JSON.parse(jsonStr);
      // Extract from HTML content fields
      const htmlFields = [
        data.chapterContentHtml, data.chapterContent, data.content,
        data.htmlContent, data.html,
        data.data?.chapterContentHtml, data.data?.chapterContent,
      ];
      for (const html of htmlFields) {
        if (html && typeof html === 'string' && html.length > 50) {
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');
          const blocks = doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote');
          const paragraphs = [];
          for (const block of blocks) {
            const text = block.textContent?.trim();
            if (text && text.length >= 2) paragraphs.push(text);
          }
          if (paragraphs.length > 0) return paragraphs;
          // Fallback: strip tags
          const stripped = html.replace(/<[^>]+>/g, '\n').split(/\n+/)
            .map(s => s.trim()).filter(s => s.length >= 5);
          if (stripped.length > 0) return stripped;
        }
      }
      return [];
    } catch { return []; }
  });
}

/**
 * Open TOC panel using Puppeteer real click.
 * Returns list of TOC entry selectors.
 */
async function openWeReadToc(page) {
  // Find and click the catalog button
  const clicked = await page.evaluate(() => {
    const selectors = [
      'button[class*="catalog"]', 'button[class*="Catalog"]',
      '[class*="readerControls"] [class*="catalog"]',
      '[class*="readerControls"] [class*="Catalog"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn) { btn.scrollIntoView(); return sel; }
    }
    // Fallback by text
    const btns = document.querySelectorAll('button, [role="button"], span[class*="readerControls"]');
    for (const btn of btns) {
      if (btn.textContent?.trim()?.includes('目录')) {
        btn.scrollIntoView();
        return '.toc-btn-fallback';
      }
    }
    return null;
  });

  if (!clicked) return [];

  // Use Puppeteer's real click (isTrusted: true)
  if (clicked === '.toc-btn-fallback') {
    // Click by text content
    const btns = await page.$$('button, [role="button"], span[class*="readerControls"]');
    for (const btn of btns) {
      const text = await btn.evaluate(el => el.textContent?.trim());
      if (text?.includes('目录')) {
        await btn.click();
        break;
      }
    }
  } else {
    await page.click(clicked);
  }

  await sleep(800);

  // Get TOC entries
  const tocEntries = await page.evaluate(() => {
    const listSelectors = [
      '.readerCatalog_list li', '[class*="readerCatalog"] li',
      '[class*="catalog_list"] li', '[class*="catalogList"] li',
    ];
    let items = null;
    let selector = '';
    for (const sel of listSelectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) { items = els; selector = sel; break; }
    }
    if (!items) {
      // Broader fallback
      const panels = document.querySelectorAll('[class*="catalog"], [class*="Catalog"], [class*="drawer"]');
      for (const panel of panels) {
        const lis = panel.querySelectorAll('li');
        if (lis.length > 2) { items = lis; selector = 'fallback-li'; break; }
      }
    }
    if (!items) return { entries: [], selector: '' };
    const entries = [];
    items.forEach((li) => {
      let text = li.innerText?.trim() || li.textContent?.trim() || '';
      text = text.replace(/当前读到\s*\d+%.*$/, '').trim();
      if (text && text.length >= 1) entries.push(text);
    });
    return { entries, selector, count: items.length };
  });

  return tocEntries;
}

/**
 * Click a specific TOC entry using Puppeteer's real mouse events.
 */
async function clickWeReadTocEntry(page, tocSelector, index) {
  if (!tocSelector) return false;

  // Get the element handle for the specific TOC entry
  let items;
  if (tocSelector === 'fallback-li') {
    // Find panel and get li elements
    items = await page.$$('[class*="catalog"] li, [class*="Catalog"] li, [class*="drawer"] li');
  } else {
    items = await page.$$(tocSelector);
  }

  if (index >= items.length) return false;
  const entry = items[index];
  await entry.scrollIntoViewIfNeeded();
  await sleep(100);
  await entry.click(); // Puppeteer real click → isTrusted: true
  return true;
}

/**
 * Wait for layout data to update after chapter navigation.
 * Detects change by comparing first-line text before and after.
 */
async function waitForLayoutChange(page, prevFirstLine, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const layout = await readWeReadLayoutText(page);
    if (layout.lines.length > 0 && layout.lines[0] !== prevFirstLine) {
      return layout;
    }
    await sleep(200);
  }
  // Return whatever we have even if unchanged
  return readWeReadLayoutText(page);
}

/**
 * Merge layout lines into paragraphs.
 * Canvas lines are wrapped at column width — consecutive lines form paragraphs.
 * Use heuristic: new paragraph starts when a line follows a short line (< 80% of max width)
 * or when a line starts with typical paragraph markers.
 */
function mergeLinesToParagraphs(lines) {
  if (lines.length === 0) return [];
  if (lines.length === 1) return [lines[0]];

  // Find typical line length (most frequent range)
  const maxLen = Math.max(...lines.map(l => l.length));
  const threshold = maxLen * 0.75;

  const paragraphs = [];
  let current = lines[0];

  for (let i = 1; i < lines.length; i++) {
    const prevLine = lines[i - 1];
    const line = lines[i];

    // New paragraph if previous line was short (not filling the column)
    const prevShort = prevLine.length < threshold;

    if (prevShort) {
      // Previous line didn't fill the width → end of paragraph
      if (current.trim()) paragraphs.push(current.trim());
      current = line;
    } else {
      // Continue current paragraph
      current += line;
    }
  }
  if (current.trim()) paragraphs.push(current.trim());

  return paragraphs;
}

// ---- Main: WeRead flow (Puppeteer-driven navigation) ----

async function syncWeRead(browser, extId, page, maxBooks, { listOnly = false, bookFilter = null } = {}) {
  const loggedIn = await waitForLogin(page, 'weread');
  if (!loggedIn) {
    console.error('Timed out waiting for login.');
    process.exit(1);
  }

  process.stderr.write('Logged in. Scanning WeRead shelf...\n');
  await sleep(3000);

  // Get book list from shelf
  const bookList = await getWeReadBookList(page);
  process.stderr.write(`Found ${bookList.length} books on shelf.\n`);

  if (bookList.length === 0) {
    const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 3000) || '');
    process.stderr.write(`Shelf page text: ${bodyText.substring(0, 500)}\n`);
    console.error('Could not detect any books on the shelf page.');
    process.exit(1);
  }

  // --list mode: output book list as JSON and return
  if (listOnly) {
    console.log(JSON.stringify({ books: bookList.map(b => ({ title: b.title, author: b.author, bookId: b.bookId })) }));
    return { booksSynced: 0, totalBooks: bookList.length, listOnly: true };
  }

  bookList.slice(0, 5).forEach((b, i) => {
    process.stderr.write(`  ${i + 1}. "${b.title}" — ${b.author} [${b.bookId || 'no-id'}]\n`);
  });
  if (bookList.length > 5) {
    process.stderr.write(`  ... and ${bookList.length - 5} more\n`);
  }

  const syncedTitles = await getSyncedBookTitles();
  const initialBookCount = await getBookCount();
  let booksSynced = 0;

  const booksToSync = bookList.filter(book => {
    // --book filter: skip books that don't match
    if (bookFilter) {
      const filterLower = bookFilter.toLowerCase();
      const titleLower = book.title.toLowerCase();
      if (!titleLower.includes(filterLower) && !filterLower.includes(titleLower)) {
        return false;
      }
    }
    return true;
  }).map(book => ({
    ...book,
    alreadySynced: syncedTitles.some((synced) =>
      synced.toLowerCase().includes(book.title.toLowerCase().substring(0, 15)) ||
      book.title.toLowerCase().includes(synced.toLowerCase().substring(0, 15))
    ),
  }));

  if (bookFilter && booksToSync.length === 0) {
    process.stderr.write(`No book matching "${bookFilter}" found on shelf.\n`);
    return { booksSynced: 0, totalBooks: bookList.length };
  }

  const skippedCount = booksToSync.filter(b => b.alreadySynced).length;
  const pendingCount = booksToSync.filter(b => !b.alreadySynced).length;
  process.stderr.write(`\nAlready synced: ${skippedCount}, To sync: ${pendingCount}\n\n`);

  for (let i = 0; i < booksToSync.length; i++) {
    if (maxBooks && booksSynced >= maxBooks) break;

    const book = booksToSync[i];
    if (book.alreadySynced) {
      process.stderr.write(`[${i + 1}/${booksToSync.length}] Skipping "${book.title}" (already synced)\n`);
      continue;
    }

    process.stderr.write(`\n[${i + 1}/${booksToSync.length}] Syncing "${book.title}"...\n`);

    // Navigate to book reader page
    const opened = await clickWeReadBook(page, book.bookId, book.title);
    if (!opened) {
      process.stderr.write(`  Could not open "${book.title}", skipping.\n`);
      await page.goto('https://weread.qq.com/web/shelf', { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(3000);
      continue;
    }

    await page.bringToFront();
    await sleep(2000);

    // Detect pagination (double-column) mode and switch to scroll (single-column) mode
    // Pagination mode has pager buttons ("上一页"/"下一页") or the isHorizontalReader control is active
    const isPagination = await page.evaluate(() => {
      return !!(document.querySelector('.renderTarget_pager_button') ||
                document.querySelector('.readerControls_item.isHorizontalReader'));
    });
    if (isPagination) {
      process.stderr.write(`  Detected pagination mode, switching to scroll mode...\n`);
      // Click the isHorizontalReader toggle button directly — it switches between pagination/scroll
      // Must use Puppeteer real click (isTrusted: true), WeRead React ignores element.click()
      const toggleBtn = await page.$('.readerControls_item.isHorizontalReader');
      if (toggleBtn) {
        await toggleBtn.click(); // Puppeteer real click
        await sleep(3000); // Wait for page to re-render in scroll mode
        process.stderr.write(`  Switched to scroll mode.\n`);
      } else {
        process.stderr.write(`  Warning: Could not find layout toggle button.\n`);
      }

      // Verify we're now in scroll mode (pager buttons should be gone)
      const stillPagination = await page.evaluate(() => {
        return !!document.querySelector('.renderTarget_pager_button');
      });
      if (stillPagination) {
        process.stderr.write(`  Warning: Still in pagination mode. Sync may not work correctly.\n`);
      }
    }

    // Extract book meta from the reader page
    const bookMeta = await page.evaluate(() => {
      const titleEl = document.querySelector('.readerTopBar_title_link, .readerTopBar_title, [class*="readerTopBar"] [class*="title"]');
      let title = titleEl?.textContent?.trim() || '';
      if (!title) {
        title = document.title.replace(/\s*-\s*微信读书\s*$/, '').trim();
        const dash = title.lastIndexOf('-');
        if (dash > 0) title = title.substring(0, dash).trim();
      }
      const authorEl = document.querySelector('.readerTopBar_author, [class*="readerTopBar"] [class*="author"]');
      let author = authorEl?.textContent?.trim() || '';
      if (!author) {
        const dt = document.title.replace(/\s*-\s*微信读书\s*$/, '').trim();
        const dash = dt.lastIndexOf('-');
        if (dash > 0) author = dt.substring(dash + 1).trim();
      }
      const pathMatch = window.location.pathname.match(/\/web\/reader\/([^/?#]+)/);
      const bookId = pathMatch?.[1] || '';
      return { title, author, bookId };
    });

    // Open TOC using Puppeteer real click
    const tocData = await openWeReadToc(page);
    const tocEntries = tocData.entries || [];
    const tocSelector = tocData.selector || '';

    if (tocEntries.length === 0) {
      process.stderr.write(`  No TOC entries found, skipping.\n`);
      await page.goto('https://weread.qq.com/web/shelf', { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(3000);
      continue;
    }

    // Clean book title: remove chapter suffix that WeRead appends in scroll mode
    // e.g. "绿山墙的安妮  第三十八章 峰回路转" → "绿山墙的安妮"
    let cleanTitle = bookMeta.title;
    for (const entry of tocEntries) {
      if (entry.length >= 2 && cleanTitle.endsWith(entry)) {
        cleanTitle = cleanTitle.substring(0, cleanTitle.length - entry.length).trim();
        break;
      }
    }
    // Also try "第X章" pattern
    const chMatch = cleanTitle.match(/^(.+?)\s+第\d+章/);
    if (chMatch) cleanTitle = chMatch[1].trim();
    bookMeta.title = cleanTitle || bookMeta.title;

    process.stderr.write(`  Book: "${bookMeta.title}" by ${bookMeta.author} (${bookMeta.bookId})\n`);
    process.stderr.write(`  Found ${tocEntries.length} chapters in TOC.\n`);

    // Sync each chapter: Puppeteer clicks TOC entry → wait for content → extract
    const chapters = [];
    let prevFirstLine = '';

    for (let ch = 0; ch < tocEntries.length; ch++) {
      const chapterTitle = tocEntries[ch];
      process.stderr.write(`  [${ch + 1}/${tocEntries.length}] ${chapterTitle}...`);

      // Re-open TOC panel if closed
      if (ch > 0) {
        await openWeReadToc(page);
        await sleep(300);
      }

      // Click the TOC entry with Puppeteer (isTrusted: true)
      const clicked = await clickWeReadTocEntry(page, tocSelector, ch);
      if (!clicked) {
        process.stderr.write(` skip (click failed)\n`);
        continue;
      }

      // Wait for content to change
      await sleep(1500);
      const layout = await waitForLayoutChange(page, prevFirstLine, 8000);

      if (layout.lines.length > 0) {
        prevFirstLine = layout.lines[0];
        const paragraphs = mergeLinesToParagraphs(layout.lines);

        // Also try API data (if available and more complete)
        const apiParas = await readWeReadChapterData(page);
        const bestParas = (apiParas.length > paragraphs.length) ? apiParas : paragraphs;

        if (bestParas.length > 0) {
          chapters.push({ title: chapterTitle, paragraphs: bestParas });
          const totalChars = bestParas.join('').length;
          process.stderr.write(` ${bestParas.length} paras, ${totalChars} chars\n`);
        } else {
          process.stderr.write(` no content\n`);
        }
      } else {
        process.stderr.write(` no layout data\n`);
      }
    }

    // Close TOC panel
    await page.keyboard.press('Escape');
    await sleep(300);

    // Save to sync server
    if (chapters.length === 0) {
      process.stderr.write(`  ✗ No chapters captured for "${bookMeta.title}".\n`);
      await page.goto('https://weread.qq.com/web/shelf', { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(3000);
      continue;
    }

    // Determine directory ID
    const slugTitle = bookMeta.title.replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 50);
    const dirId = `${slugTitle}-${bookMeta.bookId}`;
    const allParas = chapters.flatMap(ch => ch.paragraphs.slice(0, 5));
    const cjkCount = (allParas.join('').match(/[\u4e00-\u9fff]/g) || []).length;
    const lang = cjkCount > allParas.join('').length * 0.3 ? 'zh' : 'en';
    const totalChars = chapters.reduce((sum, ch) => sum + ch.paragraphs.join('').length, 0);

    // Prepare files
    const files = [];
    const fullParts = [];

    for (let ci = 0; ci < chapters.length; ci++) {
      const chapter = chapters[ci];
      const chapterNum = String(ci + 1).padStart(2, '0');
      const content = chapter.paragraphs.join('\n\n');
      const markdown = `# ${chapter.title}\n\n${content}`;
      files.push({ path: `books/${dirId}/chapter-${chapterNum}.md`, content: markdown });
      fullParts.push(markdown);
    }

    files.push({ path: `books/${dirId}/full.md`, content: fullParts.join('\n\n---\n\n') });

    const meta = {
      title: bookMeta.title,
      author: bookMeta.author,
      bookId: bookMeta.bookId,
      language: lang,
      totalChapters: chapters.length,
      totalCharacters: totalChars,
      syncedAt: new Date().toISOString(),
      source: 'weread',
    };
    files.push({ path: `books/${dirId}/meta.json`, content: JSON.stringify(meta, null, 2) });

    // Save batch
    try {
      const res = await fetch(`http://127.0.0.1:${SYNC_SERVER_PORT}/save-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      });
      if (res.ok) {
        // Update index
        let index = { version: '1.0.0', books: [], updatedAt: '' };
        try {
          const idxRes = await fetch(`http://127.0.0.1:${SYNC_SERVER_PORT}/read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: 'index.json' }),
          });
          if (idxRes.ok) {
            const data = await idxRes.json();
            if (data.content) index = JSON.parse(data.content);
          }
        } catch {}
        const existingIdx = index.books.findIndex(b => b.id === dirId);
        if (existingIdx >= 0) index.books[existingIdx] = { id: dirId, ...meta };
        else index.books.push({ id: dirId, ...meta });
        index.updatedAt = new Date().toISOString();
        await fetch(`http://127.0.0.1:${SYNC_SERVER_PORT}/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: 'index.json', content: JSON.stringify(index, null, 2) }),
        });
        booksSynced++;
        process.stderr.write(`  ✓ "${bookMeta.title}" — ${chapters.length} chapters, ${totalChars.toLocaleString()} chars\n`);
      } else {
        process.stderr.write(`  ✗ Save failed: ${res.statusText}\n`);
      }
    } catch (e) {
      process.stderr.write(`  ✗ Save error: ${e.message}\n`);
    }

    // Go back to shelf for next book
    if (!(maxBooks && booksSynced >= maxBooks)) {
      process.stderr.write('  Returning to shelf...\n');
      await page.goto('https://weread.qq.com/web/shelf', { waitUntil: 'networkidle2', timeout: 60000 });
      await sleep(3000);
    }
  }

  const finalCount = await getBookCount();
  return { booksSynced, totalBooks: finalCount, booksAdded: finalCount - initialBookCount };
}

// ---- Main ----

async function main() {
  const args = process.argv.slice(2);
  const source = args[0]?.toLowerCase();

  if (!source || !['kindle', 'weread'].includes(source)) {
    console.error('Usage: node scripts/sync-books.js <kindle|weread> [--max N] [--list] [--book "title"]');
    console.error('');
    console.error('Examples:');
    console.error('  node scripts/sync-books.js kindle              # Sync all Kindle books');
    console.error('  node scripts/sync-books.js kindle --max 3      # Sync at most 3 books');
    console.error('  node scripts/sync-books.js kindle --list        # List books without syncing');
    console.error('  node scripts/sync-books.js kindle --book "书名"  # Sync only the matching book');
    console.error('  node scripts/sync-books.js weread               # Sync from WeRead');
    process.exit(1);
  }

  const maxIdx = args.indexOf('--max');
  const maxBooks = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : 0;
  const listOnly = args.includes('--list');
  const bookIdx = args.indexOf('--book');
  const bookFilter = bookIdx >= 0 ? args[bookIdx + 1] : null;

  // Step 0: Auto-setup — install dependencies + build extension if needed
  ensureDependencies();
  const extPath = ensureExtensionBuilt();

  // Step 1: Start sync server
  process.stderr.write('Starting sync server...\n');
  let syncServerProcess = null;
  const alreadyRunning = await waitForSyncServer(2);
  if (!alreadyRunning) {
    syncServerProcess = startSyncServer();
    const ready = await waitForSyncServer();
    if (!ready) {
      console.error('Error: Sync server failed to start');
      syncServerProcess?.kill();
      process.exit(1);
    }
  }
  process.stderr.write('Sync server ready.\n');

  let browser;
  try {
    // Step 2: Launch Chrome with extension (uses same profile as sync-login.js, login session preserved)
    browser = await launchChrome(extPath);

    // Step 3: Find extension
    process.stderr.write('Finding CastReader extension...\n');
    const extId = await findExtensionId(browser);
    process.stderr.write(`Extension ID: ${extId}\n`);

    // Step 4: Navigate to library
    const urls = {
      kindle: 'https://read.amazon.com/kindle-library',
      weread: 'https://weread.qq.com/web/shelf',
    };
    process.stderr.write(`Navigating to ${urls[source]}...\n`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(urls[source], { waitUntil: 'networkidle2', timeout: 60000 });

    // Step 5: Source-specific sync flow
    let result;
    if (source === 'kindle') {
      result = await syncKindle(browser, extId, page, maxBooks, { listOnly, bookFilter });
    } else {
      result = await syncWeRead(browser, extId, page, maxBooks, { listOnly, bookFilter });
    }

    // Output result
    console.log(JSON.stringify({
      success: true,
      source,
      ...result,
      libraryPath: LIBRARY_PATH,
    }));

  } finally {
    if (browser) {
      process.stderr.write('\nSync complete. Closing browser...\n');
      await browser.close().catch(() => {});
    }
    if (syncServerProcess) {
      syncServerProcess.kill();
    }
  }
}

// Export for testing
if (typeof module !== 'undefined') {
  module.exports = { mergeLinesToParagraphs };
}

// Only run main when executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
