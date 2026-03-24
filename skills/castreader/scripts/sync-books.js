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
const LIBRARY_PATH = path.join(os.homedir(), 'castreader-library');
const COOKIE_BACKUP_DIR = path.join(os.homedir(), '.castreader-cookies');

// Lazy-loaded puppeteer (installed on demand)
let puppeteer;
let _activeBrowser = null;

// Ensure Chrome is closed on unexpected termination (SIGTERM from ClawBot timeout, etc.)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (_activeBrowser) {
      process.stderr.write(`\n[${sig}] Closing browser...\n`);
      await _activeBrowser.close().catch(() => {});
    }
    process.exit(1);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- Cookie Backup / Restore ----

async function backupCookies(page, source) {
  try {
    const cookies = await page.cookies();
    if (!cookies.length) return;
    fs.mkdirSync(COOKIE_BACKUP_DIR, { recursive: true });
    const backupPath = path.join(COOKIE_BACKUP_DIR, `${source}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(cookies, null, 2), 'utf-8');
    process.stderr.write(`  Cookies backed up (${cookies.length} cookies)\n`);
  } catch (e) {
    process.stderr.write(`  Cookie backup failed: ${e.message}\n`);
  }
}

async function restoreCookies(page, source) {
  try {
    const backupPath = path.join(COOKIE_BACKUP_DIR, `${source}.json`);
    if (!fs.existsSync(backupPath)) return false;
    const cookies = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
    if (!cookies.length) return false;
    // Filter out expired cookies
    const now = Date.now() / 1000;
    const valid = cookies.filter(c => !c.expires || c.expires === -1 || c.expires > now);
    if (!valid.length) return false;
    await page.setCookie(...valid);
    process.stderr.write(`  Restored ${valid.length} cookies from backup\n`);
    return true;
  } catch (e) {
    process.stderr.write(`  Cookie restore failed: ${e.message}\n`);
    return false;
  }
}

// ---- Library ----

async function getBookCount() {
  try {
    const indexPath = path.join(LIBRARY_PATH, 'index.json');
    if (fs.existsSync(indexPath)) {
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      return (index.books || []).length;
    }
  } catch {}
  return 0;
}

async function getSyncedBookTitles() {
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

  // Quick check first
  const immediate = checkSW();
  if (immediate) return immediate;

  process.stderr.write('  Waiting for service worker...\n');

  // Wake SW by opening extension popup page (keep it open — closing kills dormant SW)
  try {
    const pages = await browser.pages();
    const hasPopup = pages.some(p => p.url().includes(`chrome-extension://${extId}/`));
    if (!hasPopup) {
      const wakePage = await browser.newPage();
      await wakePage.goto(`chrome-extension://${extId}/popup.html`, { timeout: 5000 }).catch(() => {});
      await sleep(2000);
      // Don't close — keeping popup open keeps SW alive
    }
  } catch {}

  // Wait for SW to appear
  for (let i = 0; i < 15; i++) {
    const sw = checkSW();
    if (sw) return sw;
    if (i === 0 || i === 5) {
      // Debug: log all targets
      const allTargets = browser.targets();
      process.stderr.write(`  [debug] ${allTargets.length} targets:\n`);
      for (const t of allTargets) {
        process.stderr.write(`    type=${t.type()} url=${t.url().substring(0, 80)}\n`);
      }
    }
    await sleep(2000);
  }
  return null;
}

/**
 * Send message to extension via the popup page's chrome.runtime.sendMessage.
 * The popup page has full access to chrome.* APIs and auto-wakes the SW.
 * Falls back to SW CDP approach if popup is unavailable.
 */
let contentInjected = false;

async function sendMessageToActiveTab(browser, extId, message, page) {
  const msgJson = JSON.stringify(message);
  const needsInject = !contentInjected;

  // Strategy 1: Use popup page to relay message to content script via SW
  const popupPage = await getOrOpenPopupPage(browser, extId);
  if (popupPage) {
    try {
      const result = await popupPage.evaluate(async (msg, shouldInject) => {
        try {
          // Find the book tab (Kindle or WeRead)
          const allTabs = await chrome.tabs.query({});
          const bookTab = allTabs.find(t =>
            t.url?.includes('read.amazon.com') || t.url?.includes('weread.qq.com')
          );
          if (!bookTab || !bookTab.id) {
            return { success: false, error: 'No book tab found' };
          }

          // Only inject content.js on first call (it's not auto-injected via manifest)
          if (shouldInject) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: bookTab.id },
                files: ['content-scripts/content.js'],
              });
              await new Promise(r => setTimeout(r, 3000));
            } catch (injectErr) {
              // May already be injected — ignore
            }
          }

          try {
            const response = await chrome.tabs.sendMessage(bookTab.id, msg);
            return { success: true, tabId: bookTab.id, response };
          } catch (e) {
            return { success: false, tabId: bookTab.id, error: e.message };
          }
        } catch (e) {
          return { success: false, error: e.message };
        }
      }, message, needsInject);

      if (result) {
        if (result.success) {
          contentInjected = true;
        } else if (result.error && result.error.includes('Receiving end')) {
          // Content script not responding — need to re-inject next time
          contentInjected = false;
        }
        return result;
      }
    } catch (e) {
      process.stderr.write(`  Popup relay error: ${e.message}\n`);
    }
  }

  // Strategy 2: Find SW target and evaluate directly (fallback)
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
              return JSON.stringify({ success: false, error: e.message });
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

  const first = await trySendViaSW();
  if (first && first.success) return first;

  return first || { success: false, error: 'Could not communicate with extension' };
}

// Helper: get existing popup page or open one
async function getOrOpenPopupPage(browser, extId) {
  const pages = await browser.pages();
  let popup = pages.find(p => p.url().includes(`chrome-extension://${extId}/`));
  if (popup) return popup;

  try {
    popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`, { timeout: 10000 });
    await sleep(1000);
    return popup;
  } catch (e) {
    process.stderr.write(`  Could not open popup page: ${e.message}\n`);
    return null;
  }
}

/**
 * Drive page flips via Puppeteer at maximum speed, poll status separately.
 *
 * Architecture: Two concurrent loops —
 *   FLIP LOOP: fires page.keyboard.press('ArrowRight') every 300ms non-stop.
 *              Collector detects image change (~50ms poll) and captures.
 *              At batch boundary, Kindle ignores flips until next batch renders,
 *              so extra flips are harmless.
 *   STATUS LOOP: checks progress every 3s to detect done/error and show progress.
 */
async function waitForSyncComplete(browser, extId, bookTitle, page, timeoutMs = 30 * 60 * 1000) {
  const start = Date.now();
  let lastMsg = '';
  let done = false;
  let result = { success: false, error: 'timeout' };

  // ---- FLIP LOOP: fire ArrowRight at ~300ms intervals ----
  const flipLoop = (async () => {
    // Initial delay: let collector capture the first page before flipping
    await sleep(2000);

    while (!done && Date.now() - start < timeoutMs) {
      if (page) {
        await page.keyboard.press('ArrowRight');
      }
      await sleep(300);
    }
  })();

  // ---- STATUS LOOP: poll progress every 3s ----
  const statusLoop = (async () => {
    while (!done && Date.now() - start < timeoutMs) {
      await sleep(3000);

      let statusResult;
      try {
        statusResult = await Promise.race([
          sendMessageToActiveTab(browser, extId, { type: 'SYNC_LIBRARY_STATUS' }, page),
          sleep(10000).then(() => ({ success: false, error: 'poll timeout' })),
        ]);
      } catch (e) {
        continue;
      }
      if (!statusResult?.success) continue;

      const resp = statusResult.response;
      if (!resp) continue;

      const progress = resp.progress;
      if (progress) {
        const msg = `  [${bookTitle}] ${progress.status}: page ${progress.currentPage}/${progress.totalPages} (${progress.percent || 0}%)`;
        if (msg !== lastMsg) {
          process.stderr.write(msg + '\n');
          lastMsg = msg;
        }

        if (progress.status === 'done') {
          done = true;
          result = { success: true };
          return;
        }
        if (progress.status === 'error') {
          done = true;
          result = { success: false, error: progress.message };
          return;
        }
        if (progress.status === 'cancelled') {
          done = true;
          result = { success: false, error: 'cancelled' };
          return;
        }
      }

      if (resp.syncing === false && progress?.status === 'done') {
        done = true;
        result = { success: true };
        return;
      }
    }
  })();

  await Promise.all([flipLoop, statusLoop]);
  return result;
}

/**
 * Puppeteer-native Kindle sync: flip + screenshot + local tesseract OCR.
 * 10x faster than extension's wasm OCR. No extension involvement needed.
 */
async function puppeteerNativeSync(page, book) {
  const { execSync } = require('child_process');

  const title = book.title;
  const asin = book.asin || book.id || 'unknown';
  const bookId = slugify(title) + '-' + asin;
  const tmpDir = path.join(os.tmpdir(), 'castreader-ocr-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  process.stderr.write(`  [native-sync] "${title}" (${asin})\n`);

  // ---- OCR engine detection: Vision (macOS) → PaddleOCR (cross-platform) → Tesseract (fallback) ----
  const visionOcrBatch = path.resolve(__dirname, 'ocr-vision-batch');
  const paddleOcrBatch = path.resolve(__dirname, 'ocr-paddle-batch.py');
  const hasVisionOcr = fs.existsSync(visionOcrBatch) && process.platform === 'darwin';
  let hasPaddleOcr = false;
  if (!hasVisionOcr && fs.existsSync(paddleOcrBatch)) {
    try { execSync('python3 -c "from paddleocr import PaddleOCR"', { stdio: 'pipe', timeout: 10000 }); hasPaddleOcr = true; }
    catch { /* PaddleOCR not installed */ }
  }
  const ocrEngine = hasVisionOcr ? 'vision' : hasPaddleOcr ? 'paddle' : 'tesseract';
  if (ocrEngine === 'tesseract') {
    try { execSync('tesseract --version', { stdio: 'pipe' }); }
    catch { return { success: false, error: 'No OCR available. Install PaddleOCR (pip install paddlepaddle paddleocr) or Tesseract.' }; }
  }

  const pipelineStart = Date.now();

  // ---- CDP session for native screenshots ----
  const cdp = await page.createCDPSession();
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);

  // Find the Kindle page image bounding rect (once)
  const imgClip = await page.evaluate(() => {
    const imgs = document.querySelectorAll('img[src^="blob:"]');
    for (const img of imgs) {
      if (img.naturalWidth > 0) {
        const r = img.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }
    }
    return null;
  });
  if (!imgClip) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { success: false, error: 'No Kindle page image found' };
  }

  // ---- Helper: CDP screenshot → canvas resize → smaller PNG for OCR ----
  // CDP screenshot captures at viewport resolution (large with big viewport).
  // Resize via canvas in page to keep OCR fast.
  const capturePageFast = async (pageNum) => {
    const imgPath = path.join(tmpDir, `page-${String(pageNum).padStart(4, '0')}.png`);
    // Use canvas to grab blob image at capped resolution (fast OCR)
    const dataUrl = await page.evaluate(() => {
      const imgs = document.querySelectorAll('img[src^="blob:"]');
      let bestImg = null;
      for (const img of imgs) {
        if (img.naturalWidth > 0 && (!bestImg || img.naturalWidth > bestImg.naturalWidth)) bestImg = img;
      }
      if (!bestImg) return null;
      const canvas = document.createElement('canvas');
      // Cap height for fast OCR while keeping text readable
      const maxH = 1200;
      const scale = bestImg.naturalHeight > maxH ? maxH / bestImg.naturalHeight : 1;
      canvas.width = Math.round(bestImg.naturalWidth * scale);
      canvas.height = Math.round(bestImg.naturalHeight * scale);
      canvas.getContext('2d').drawImage(bestImg, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    });
    if (dataUrl) {
      fs.writeFileSync(imgPath, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
    } else {
      // Fallback to CDP screenshot
      try {
        const { data } = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          clip: { ...imgClip, scale: 1 / dpr },
        });
        fs.writeFileSync(imgPath, Buffer.from(data, 'base64'));
      } catch {
        const el = await page.$('#kr-renderer') || await page.$('body');
        await el.screenshot({ path: imgPath });
      }
    }
    return imgPath;
  };

  // ---- Single evaluate: get src + percent in one IPC round-trip ----
  const getPageState = async () => {
    return page.evaluate(() => {
      let src = '';
      const imgs = document.querySelectorAll('img[src^="blob:"]');
      for (const img of imgs) { if (img.naturalWidth > 0) { src = img.src; break; } }
      const m = document.body.innerText.match(/(\d+)%/);
      return { src, pct: m ? parseInt(m[1]) : 0 };
    });
  };

  // ---- Async OCR batch runner ----
  const runOcrBatchAsync = (startIdx, count) => {
    const batchDir = path.join(tmpDir, `batch-${startIdx}`);
    fs.mkdirSync(batchDir, { recursive: true });
    for (let i = startIdx; i < startIdx + count; i++) {
      const src = path.join(tmpDir, `page-${String(i + 1).padStart(4, '0')}.png`);
      const dst = path.join(batchDir, `page-${String(i + 1).padStart(4, '0')}.png`);
      if (fs.existsSync(src)) {
        try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
      }
    }
    if (ocrEngine === 'vision' || ocrEngine === 'paddle') {
      // Both Vision and PaddleOCR use the same interface: <binary> <dir> → JSON array stdout
      const cmd = ocrEngine === 'vision' ? visionOcrBatch : 'python3';
      const args = ocrEngine === 'vision' ? [batchDir] : [paddleOcrBatch, batchDir];
      return new Promise((resolve) => {
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => process.stderr.write(`  [ocr-${startIdx}] ${d}`));
        child.on('close', () => {
          try { resolve(JSON.parse(stdout).map(t => t.trim())); }
          catch { resolve(new Array(count).fill('')); }
          fs.rmSync(batchDir, { recursive: true, force: true });
        });
      });
    } else {
      // Tesseract fallback (per-image, sequential)
      return (async () => {
        const results = [];
        for (let i = startIdx; i < startIdx + count; i++) {
          const imgPath = path.join(tmpDir, `page-${String(i + 1).padStart(4, '0')}.png`);
          try { results.push(execSync(`tesseract "${imgPath}" stdout -l eng --psm 6 2>/dev/null`, { encoding: 'utf-8' }).trim()); }
          catch { results.push(''); }
        }
        fs.rmSync(batchDir, { recursive: true, force: true });
        return results;
      })();
    }
  };

  // ---- PIPELINED CAPTURE + PARALLEL OCR ----
  // OCR starts as soon as first batch of pages is captured.
  // Uses 8 parallel OCR workers to maximize CPU utilization.
  let pageNum = 0;
  let lastSrc = '';
  let kindlePercent = 0;
  let stuckCount = 0;
  const MAX_STUCK = 30;
  const allText = [];
  const OCR_PARALLELISM = 8;
  const OCR_BATCH_SIZE = 8; // small batches for fast pipeline start
  const ocrQueue = []; // { startIdx, count, promise, done, result }
  let ocrDispatchedUpTo = 0;

  const engineNames = { vision: 'Apple Vision', paddle: 'PaddleOCR', tesseract: 'Tesseract' };
  process.stderr.write(`  [native-sync] Large viewport (${imgClip.width}x${imgClip.height}) + ${OCR_PARALLELISM}x pipelined ${engineNames[ocrEngine]}...\n`);

  const dispatchOcr = () => {
    while (pageNum - ocrDispatchedUpTo >= OCR_BATCH_SIZE) {
      const startIdx = ocrDispatchedUpTo;
      ocrQueue.push({ startIdx, count: OCR_BATCH_SIZE, promise: runOcrBatchAsync(startIdx, OCR_BATCH_SIZE), done: false });
      ocrDispatchedUpTo += OCR_BATCH_SIZE;
    }
  };

  // Mark completed OCR batches (non-blocking check)
  const markDone = async () => {
    for (const q of ocrQueue) {
      if (!q.done) {
        const r = await Promise.race([q.promise.then(v => ({ v })), Promise.resolve(null)]);
        if (r) { q.result = r.v; q.done = true; }
      }
    }
  };

  // Throttle if too many active workers
  const throttle = async () => {
    while (ocrQueue.filter(q => !q.done).length >= OCR_PARALLELISM) {
      await sleep(30);
      await markDone();
    }
  };

  // FAST CAPTURE with pipelined OCR
  while (kindlePercent < 99 && stuckCount < MAX_STUCK) {
    const state = await getPageState();

    if (state.src && state.src !== lastSrc) {
      pageNum++;
      stuckCount = 0;
      lastSrc = state.src;
      kindlePercent = state.pct;

      await capturePageFast(pageNum);

      if (pageNum % 10 === 0 || kindlePercent >= 99) {
        process.stderr.write(`  [capture] page ${pageNum} (${kindlePercent}%)\n`);
      }

      // Dispatch OCR batches as pages accumulate
      dispatchOcr();
      await throttle();

      await page.keyboard.press('ArrowRight');
    } else {
      stuckCount++;
      if (stuckCount % 3 === 0) await page.keyboard.press('ArrowRight');
      await sleep(50);
    }
  }

  const captureTime = ((Date.now() - pipelineStart) / 1000).toFixed(1);
  process.stderr.write(`  [native-sync] Capture done: ${pageNum} pages in ${captureTime}s\n`);
  await cdp.detach().catch(() => {});

  if (pageNum === 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { success: false, error: 'No pages captured' };
  }

  // Dispatch remaining pages
  if (ocrDispatchedUpTo < pageNum) {
    const startIdx = ocrDispatchedUpTo;
    const count = pageNum - ocrDispatchedUpTo;
    ocrQueue.push({ startIdx, count, promise: runOcrBatchAsync(startIdx, count), done: false });
  }

  // Wait for all OCR to finish
  const activeCount = ocrQueue.filter(q => !q.done).length;
  if (activeCount > 0) {
    process.stderr.write(`  [native-sync] Waiting for ${activeCount} OCR batches...\n`);
  }
  for (const q of ocrQueue) {
    if (!q.done) { q.result = await q.promise; q.done = true; }
  }

  // Collect in order
  ocrQueue.sort((a, b) => a.startIdx - b.startIdx);
  for (const q of ocrQueue) {
    for (const t of (q.result || [])) { if (t) allText.push(t); }
  }

  const totalPipeTime = ((Date.now() - pipelineStart) / 1000).toFixed(1);
  process.stderr.write(`  [native-sync] Done: capture=${captureTime}s, total=${totalPipeTime}s\n`);

  // Cleanup temp images
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // ---- PHASE 3: Split into chapters and save ----
  const fullText = allText.join('\n\n');
  if (!fullText.trim()) {
    return { success: false, error: 'OCR produced no text' };
  }

  process.stderr.write(`  [native-sync] Phase 3: Splitting chapters (${fullText.length.toLocaleString()} chars)...\n`);

  // Simple chapter splitting: look for "Chapter N" or similar patterns
  const chapters = splitIntoChapters(fullText, title);

  // Save directly to filesystem (faster and more reliable than sync server for large files)
  const bookDir = path.join(LIBRARY_PATH, 'books', bookId);
  fs.mkdirSync(bookDir, { recursive: true });

  // Clean old chapter files
  try {
    for (const f of fs.readdirSync(bookDir)) {
      if (f.startsWith('chapter-') || f === 'full.md') fs.unlinkSync(path.join(bookDir, f));
    }
  } catch {}

  // meta.json
  fs.writeFileSync(path.join(bookDir, 'meta.json'), JSON.stringify({
    title, author: book.author || '', source: 'kindle', asin,
    chapters: chapters.map((ch, i) => ({ index: i + 1, title: ch.title })),
    syncedAt: new Date().toISOString(),
    totalChars: fullText.length,
  }, null, 2));

  // Chapter files
  for (let i = 0; i < chapters.length; i++) {
    fs.writeFileSync(path.join(bookDir, `chapter-${String(i + 1).padStart(2, '0')}.md`),
      `# ${chapters[i].title}\n\n${chapters[i].content}`);
  }

  // full.md
  fs.writeFileSync(path.join(bookDir, 'full.md'), `# ${title}\n\n${fullText}`);

  // Update index.json (direct filesystem, no sync server)
  try {
    const indexPath = path.join(LIBRARY_PATH, 'index.json');
    let existing = { books: [] };
    if (fs.existsSync(indexPath)) {
      existing = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    }
    existing.books = (existing.books || []).filter(b => b.id !== bookId);
    existing.books.push({ id: bookId, title, author: book.author || '', source: 'kindle', syncedAt: new Date().toISOString() });
    fs.writeFileSync(indexPath, JSON.stringify(existing, null, 2));
  } catch {}

  const totalTime = ((Date.now() - pipelineStart) / 1000).toFixed(1);
  process.stderr.write(`  [native-sync] Done! ${chapters.length} chapters, ${fullText.length.toLocaleString()} chars in ${totalTime}s\n`);
  return { success: true };
}

/** Split full text into chapters by detecting chapter headings */
function splitIntoChapters(fullText, bookTitle) {
  // Try common chapter patterns
  const patterns = [
    /^(Chapter\s+\d+[^\n]*)/im,
    /^(CHAPTER\s+[IVXLCDM\d]+[^\n]*)/m,
    /^(第[一二三四五六七八九十百千\d]+[章节回][^\n]*)/m,
  ];

  let splitRegex = null;
  for (const pattern of patterns) {
    if (pattern.test(fullText)) {
      // Build a global version for splitting
      splitRegex = new RegExp(pattern.source, 'gm' + (pattern.flags.includes('i') ? 'i' : ''));
      break;
    }
  }

  if (!splitRegex) {
    // No chapter pattern found — split by page breaks or just return as single chapter
    const chunks = fullText.split(/\n{4,}/);
    if (chunks.length > 3) {
      return chunks.map((chunk, i) => ({
        title: `Section ${i + 1}`,
        content: chunk.trim(),
      })).filter(ch => ch.content.length > 50);
    }
    return [{ title: bookTitle, content: fullText }];
  }

  // Split at chapter headings
  const chapters = [];
  const matches = [...fullText.matchAll(splitRegex)];

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : fullText.length;
    const chapterText = fullText.substring(start, end).trim();
    const heading = matches[i][1].trim();
    const content = chapterText.substring(heading.length).trim();
    if (content.length > 10) {
      chapters.push({ title: heading, content });
    }
  }

  // Include any text before the first chapter heading
  if (matches.length > 0 && matches[0].index > 100) {
    const preamble = fullText.substring(0, matches[0].index).trim();
    if (preamble.length > 50) {
      chapters.unshift({ title: 'Preamble', content: preamble });
    }
  }

  return chapters.length > 0 ? chapters : [{ title: bookTitle, content: fullText }];
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
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

/**
 * Auto-fill Amazon login form with email and password.
 * Amazon login is a two-step form: email → continue → password → sign in.
 */
async function kindleAutoLogin(page, email, password) {
  process.stderr.write('  Auto-filling Kindle login...\n');

  // Step 0: If on landing page (not the login form), navigate to login
  const currentUrl = page.url();
  if (currentUrl.includes('read.amazon.com/landing')) {
    process.stderr.write('  On landing page, navigating to sign-in...\n');
    // Find the sign-in link by clicking it or navigate directly
    try {
      const clicked = await page.evaluate(() => {
        // Find any link/button containing "Sign in" text
        const els = document.querySelectorAll('a, button');
        for (const el of els) {
          if (el.textContent?.includes('Sign in')) {
            el.click();
            return true;
          }
        }
        return false;
      });
      if (!clicked) {
        // Direct navigation to Amazon sign-in with return to Kindle
        await page.goto('https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fread.amazon.com%2Fkindle-library&openid.assoc_handle=amzn_kweb&openid.mode=checkid_setup&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0', { waitUntil: 'networkidle2', timeout: 30000 });
      }
      await sleep(3000);
    } catch (e) {
      process.stderr.write(`  Landing page nav failed: ${e.message}\n`);
      // Last resort: direct sign-in URL
      await page.goto('https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fread.amazon.com%2Fkindle-library', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await sleep(3000);
    }
  }

  // Step 1: Email
  try {
    await page.waitForSelector('#ap_email', { timeout: 10000 });
    await page.type('#ap_email', email, { delay: 50 });
    // Click continue or sign-in (Amazon shows either depending on state)
    const continueBtn = await page.$('#continue');
    const signInBtn = await page.$('#signInSubmit');
    if (continueBtn) {
      await continueBtn.click();
    } else if (signInBtn) {
      // Single-page login — password field may already be visible
    }
    await sleep(2000);
  } catch (e) {
    process.stderr.write(`  Email input failed: ${e.message}\n`);
    return false;
  }

  // Step 2: Password
  try {
    await page.waitForSelector('#ap_password', { visible: true, timeout: 10000 });
    await page.type('#ap_password', password, { delay: 50 });
    const signIn = await page.$('#signInSubmit');
    if (signIn) {
      await signIn.click();
    }
    process.stderr.write('  Credentials submitted, waiting for login...\n');
    await sleep(3000);
  } catch (e) {
    process.stderr.write(`  Password input failed: ${e.message}\n`);
    return false;
  }

  // Check for 2FA / CAPTCHA / errors
  try {
    const currentUrl = page.url();
    if (currentUrl.includes('/ap/mfa') || currentUrl.includes('/ap/cvf')) {
      // 2FA required — emit event so bot can ask user for code
      const screenshotPath = path.join(os.tmpdir(), `kindle-2fa-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath });
      console.log(JSON.stringify({
        event: 'kindle_2fa_required',
        source: 'kindle',
        screenshot: screenshotPath,
        message: '亚马逊需要验证码，请查看手机短信或邮箱，把验证码发给我。',
      }));
      process.stderr.write('  2FA required — waiting for code input...\n');
      // Don't return false — let the polling loop handle completion
    }
    // Check for error messages (wrong password, etc.)
    const errorMsg = await page.evaluate(() => {
      const el = document.querySelector('#auth-error-message-box .a-list-item, .a-alert-content');
      return el?.textContent?.trim() || '';
    });
    if (errorMsg) {
      console.log(JSON.stringify({
        event: 'kindle_login_error',
        source: 'kindle',
        message: errorMsg,
      }));
      process.stderr.write(`  Login error: ${errorMsg}\n`);
      return false;
    }
  } catch { /* page navigating after successful login */ }

  return true; // credentials submitted, polling loop will check completion
}

async function waitForLogin(page, source, credentials) {
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
        // Fall through to cookie restore / login wait
      } else {
        process.stderr.write('Already logged in.\n');
        await backupCookies(page, source);
        return true;
      }
    } else {
      process.stderr.write('Already logged in.\n');
      await backupCookies(page, source);
      return true;
    }
  }

  // Try restoring cookies from backup before prompting user to log in
  const restored = await restoreCookies(page, source);
  if (restored) {
    process.stderr.write('  Reloading with restored cookies...\n');
    const targetUrls = { kindle: 'https://read.amazon.com/kindle-library', weread: 'https://weread.qq.com/web/shelf' };
    await page.goto(targetUrls[source], { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await sleep(2000);
    const urlAfterRestore = page.url();
    if (readyPattern.test(urlAfterRestore)) {
      if (source === 'weread') {
        const loggedIn = await isWeReadLoggedIn(page);
        if (loggedIn) {
          process.stderr.write('✓ Login restored from cookie backup!\n');
          await backupCookies(page, source);
          return true;
        }
      } else {
        process.stderr.write('✓ Login restored from cookie backup!\n');
        await backupCookies(page, source);
        return true;
      }
    }
    process.stderr.write('  Cookie restore did not work, proceeding to manual login.\n');
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
    if (source === 'kindle' && credentials?.email && credentials?.password) {
      // Auto-login with provided credentials
      const autoResult = await kindleAutoLogin(page, credentials.email, credentials.password);
      if (!autoResult) {
        console.log(JSON.stringify({
          event: 'kindle_login_error',
          source: 'kindle',
          message: '自动登录失败，请检查邮箱和密码是否正确。',
        }));
      }
      // Continue to polling loop to check login result
    } else {
      const loginMsg = {
        event: 'login_required',
        source,
        message: source === 'kindle'
          ? '需要登录 Kindle。你可以：\n1. 自己去电脑上的浏览器登录\n2. 把亚马逊邮箱和密码发给我，我帮你自动登录'
          : `Please log in to ${sourceNames[source]} in the browser window.`,
      };
      console.log(JSON.stringify(loginMsg));
      process.stderr.write(`\n🔑 Login required for ${sourceNames[source]}\n`);
      process.stderr.write(`  Waiting for login to complete...\n\n`);
    }
  }

  // Poll for login completion — check both URL and page content
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    try {
      const currentUrl = page.url();
      if (readyPattern.test(currentUrl)) {
        if (source === 'weread') {
          const loggedIn = await isWeReadLoggedIn(page);
          if (!loggedIn) continue; // URL matches but still not logged in
        }
        console.log(JSON.stringify({ event: 'login_complete', source }));
        process.stderr.write('✓ Login successful!\n');
        await backupCookies(page, source);
        return true;
      }
    } catch (e) {
      // Execution context destroyed during navigation — page is navigating after login
      process.stderr.write(`  (page navigating...)\n`);
      await sleep(3000);
      // After navigation settles, check if we're on the shelf
      try {
        const newUrl = page.url();
        if (readyPattern.test(newUrl)) {
          console.log(JSON.stringify({ event: 'login_complete', source }));
          process.stderr.write('✓ Login successful!\n');
          await backupCookies(page, source);
          return true;
        }
      } catch { /* still navigating, continue polling */ }
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

async function syncKindle(browser, extId, page, maxBooks, { listOnly = false, bookFilter = null, credentials = null } = {}) {
  // Wait for login on library page
  const loggedIn = await waitForLogin(page, 'kindle', credentials);
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

    // Bring page to front and navigate to beginning of book
    await page.bringToFront();
    await sleep(2000);

    // Check current reading progress — if not at beginning, navigate there
    const currentPct = await page.evaluate(() => {
      // Try scrubber text, page indicator, or body text
      const candidates = [
        document.querySelector('#kr-reading-progress'),
        document.querySelector('.reading-progress'),
        document.querySelector('[class*="progress"]'),
        document.querySelector('[class*="percent"]'),
      ];
      for (const el of candidates) {
        if (el) {
          const m = el.textContent?.match(/(\d+)%/);
          if (m) return parseInt(m[1]);
        }
      }
      // Try body text
      const body = document.body.innerText;
      const pageMatch = body.match(/Page \d+ of \d+\s*[·•]\s*(\d+)%/);
      if (pageMatch) return parseInt(pageMatch[1]);
      const pctMatch = body.match(/(\d+)%/);
      if (pctMatch) return parseInt(pctMatch[1]);
      return -1;
    });
    process.stderr.write(`  Current reading position: ${currentPct}%\n`);
    if (currentPct > 1) {
      process.stderr.write(`  Book at ${currentPct}%, navigating to beginning...\n`);
      // Use scrubber to jump to beginning
      await page.evaluate(() => {
        // Click center to show bottom bar
        const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        document.elementFromPoint(cx, cy)?.dispatchEvent(
          new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true })
        );
      });
      await sleep(1000);
      const jumped = await page.evaluate(() => {
        const scrubber = document.querySelector('#kr-scrubber-bar') || document.querySelector('ion-range.scrubber-bar');
        if (!scrubber) return false;
        scrubber.value = 0;
        scrubber.dispatchEvent(new CustomEvent('ionInput', { detail: { value: 0 }, bubbles: true }));
        scrubber.dispatchEvent(new CustomEvent('ionChange', { detail: { value: 0 }, bubbles: true }));
        return true;
      });
      if (jumped) {
        await sleep(4000); // Wait for Kindle to render
        process.stderr.write(`  Jumped to beginning via scrubber.\n`);
      } else {
        // Fallback: reload page with location 0
        process.stderr.write(`  Scrubber not found, reloading page...\n`);
        const url = page.url();
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await sleep(5000);
        // Try left arrow keys to get to absolute beginning
        for (let i = 0; i < 50; i++) {
          await page.keyboard.press('ArrowLeft');
          await sleep(100);
        }
        await sleep(2000);
      }
      // Press ArrowLeft a few times to ensure absolute beginning
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press('ArrowLeft');
        await sleep(200);
      }
      await sleep(1000);
    }

    // ---- Puppeteer-native sync: flip + screenshot + local tesseract OCR ----
    // No extension involvement — 10x faster than wasm OCR in offscreen document.
    process.stderr.write(`  Starting Puppeteer-native sync...\n`);
    let syncResult = await puppeteerNativeSync(page, book);

    if (!syncResult.success) {
      process.stderr.write(`  ⚠ Sync failed (${syncResult.error}). Retrying...\n`);
      await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
      await sleep(5000);
      // Navigate to beginning again
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('ArrowLeft');
        await sleep(100);
      }
      await sleep(2000);
      syncResult = await puppeteerNativeSync(page, book);
    }

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
 * Read preRenderContainer content directly from DOM.
 * Filters out encrypted containers (24-space CSS indent).
 * Returns paragraphs from the currently visible preRenderContainer(s).
 */
async function readPreRenderContent(page) {
  return page.evaluate(() => {
    const containers = document.querySelectorAll('.preRenderContainer');
    const allParagraphs = [];

    for (const container of containers) {
      // Filter encrypted containers: 24-space indent = encrypted
      const styleEl = container.querySelector('style');
      if (styleEl) {
        const styleText = styleEl.textContent || '';
        if (styleText.includes('\n                        .readerChapterContent')) {
          continue; // Skip encrypted
        }
      }

      const content = container.querySelector('#preRenderContent') || container;
      const clone = content.cloneNode(true);
      clone.querySelectorAll('style, script, noscript').forEach(s => s.remove());
      clone.querySelectorAll('.reader_footer_note, .js_readerFooterNote, [data-wr-footernote]').forEach(s => s.remove());

      const blocks = clone.querySelectorAll('p, h1, h2, h3, h4, h5, h6');
      const paragraphs = [];
      for (const block of blocks) {
        const text = block.textContent?.trim();
        if (text && text.length >= 2) paragraphs.push(text);
      }

      // Fallback: textContent split by newlines
      if (paragraphs.length === 0) {
        const text = clone.textContent?.trim();
        if (text && text.length > 10) {
          paragraphs.push(...text.split(/\n+/).map(l => l.trim()).filter(l => l.length > 2));
        }
      }

      if (paragraphs.length > 0) allParagraphs.push(...paragraphs);
    }

    return allParagraphs;
  });
}

/**
 * Set up a MutationObserver to capture ephemeral preRenderContainer content.
 *
 * WeRead scroll mode creates preRenderContainers with full chapter HTML,
 * renders them to Canvas, then immediately removes them from the DOM.
 * The MutationObserver catches the content during that brief window.
 *
 * Must be called BEFORE navigating to a chapter.
 */
async function setupPreRenderCapture(page) {
  await page.evaluate(() => {
    // Reset captured content
    window.__wrCapturedChapters = [];
    window.__wrCaptureActive = true;

    // Only set up observer once
    if (window.__wrObserver) return;

    window.__wrObserverStats = { total: 0, encrypted: 0, real: 0 };
    window.__wrObserver = new MutationObserver((mutations) => {
      if (!window.__wrCaptureActive) return;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;

          // Check if this node IS a preRenderContainer or CONTAINS one
          const containers = [];
          if (node.classList?.contains('preRenderContainer')) {
            containers.push(node);
          }
          if (node.querySelectorAll) {
            containers.push(...node.querySelectorAll('.preRenderContainer'));
          }

          for (const container of containers) {
            window.__wrObserverStats.total++;

            // Filter encrypted containers (24-space CSS indent)
            const styleEl = container.querySelector('style');
            if (styleEl) {
              const styleText = styleEl.textContent || '';
              if (styleText.includes('\n                        .readerChapterContent')) {
                window.__wrObserverStats.encrypted++;
                continue; // Encrypted, skip
              }
            }

            window.__wrObserverStats.real++;

            // Extract text from the real container
            const content = container.querySelector('#preRenderContent') || container;
            const clone = content.cloneNode(true);
            clone.querySelectorAll('style, script, noscript').forEach(s => s.remove());
            clone.querySelectorAll('.reader_footer_note, .js_readerFooterNote, [data-wr-footernote]').forEach(s => s.remove());

            const blocks = clone.querySelectorAll('p, h1, h2, h3, h4, h5, h6');
            const paragraphs = [];
            for (const block of blocks) {
              const text = block.textContent?.trim();
              if (text && text.length >= 2) paragraphs.push(text);
            }

            // Fallback: textContent split
            if (paragraphs.length === 0) {
              const text = clone.textContent?.trim();
              if (text && text.length > 10) {
                paragraphs.push(...text.split(/\n+/).map(l => l.trim()).filter(l => l.length > 2));
              }
            }

            if (paragraphs.length > 0) {
              window.__wrCapturedChapters.push(paragraphs);
            }
          }
        }
      }
    });
    window.__wrObserver.observe(document.body, { childList: true, subtree: true });
  });
}

/**
 * Read captured preRenderContainer content (does NOT clear the buffer).
 * Returns all paragraphs captured since the last reset.
 */
async function readCapturedContent(page) {
  return page.evaluate(() => {
    const captured = window.__wrCapturedChapters || [];
    // Flatten all captured chunks into one array, dedup
    const seen = new Set();
    const result = [];
    for (const chunk of captured) {
      for (const para of chunk) {
        if (!seen.has(para)) {
          seen.add(para);
          result.push(para);
        }
      }
    }
    return result;
  });
}

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
 *
 * Handles multiple formats:
 * 1. JSON with HTML content fields
 * 2. Raw hex+base64 encoded HTML (WeRead chapter API format)
 * 3. Direct HTML
 */
async function readWeReadChapterData(page) {
  return page.evaluate(() => {
    const raw = document.documentElement.getAttribute('data-castreader-wr-chapter');
    if (!raw) return [];
    const colonIdx = raw.indexOf(':');
    if (colonIdx <= 0) return [];
    const payload = raw.substring(colonIdx + 1);
    if (payload.length < 50) return [];

    /** Parse HTML string into paragraphs */
    function htmlToParagraphs(html) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      // Remove footnotes and scripts
      doc.querySelectorAll('style, script, noscript, .reader_footer_note, .js_readerFooterNote, [data-wr-footernote]').forEach(s => s.remove());
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
      return stripped;
    }

    // === Try 1: JSON format ===
    const firstChar = payload.charAt(0);
    if (firstChar === '{' || firstChar === '[') {
      try {
        const data = JSON.parse(payload);
        const htmlFields = [
          data.chapterContentHtml, data.chapterContent, data.content,
          data.htmlContent, data.html,
          data.data?.chapterContentHtml, data.data?.chapterContent,
        ];
        for (const html of htmlFields) {
          if (html && typeof html === 'string' && html.length > 50) {
            const paras = htmlToParagraphs(html);
            if (paras.length > 0) return paras;
          }
        }
      } catch {}
    }

    // === Try 2: hex(32) + base64 format (WeRead chapter API) ===
    const hexPrefix = payload.substring(0, 32);
    if (/^[0-9A-Fa-f]{32}$/.test(hexPrefix)) {
      let b64 = payload.substring(32);
      // Clean whitespace and normalize URL-safe base64
      b64 = b64.replace(/[\s\r\n]+/g, '');
      b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
      // Fix padding: mod 4 must be 0
      const mod = b64.length % 4;
      if (mod === 1) b64 = b64.substring(0, b64.length - 1); // trim extra char
      else if (mod === 2) b64 += '==';
      else if (mod === 3) b64 += '=';

      try {
        const decoded = atob(b64);
        const bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++) {
          bytes[i] = decoded.charCodeAt(i);
        }
        const text = new TextDecoder('utf-8').decode(bytes);

        // Check if readable (not encrypted binary)
        const sample = text.substring(0, 200);
        const replacements = (sample.match(/\uFFFD/g) || []).length;
        if (replacements / sample.length > 0.1) {
          console.log('[sync] Chapter data encrypted, skipping');
          return [];
        }

        // Try parsing as HTML
        if (text.includes('<p') || text.includes('<h') || text.includes('<div')) {
          const paras = htmlToParagraphs(text);
          if (paras.length > 0) {
            console.log('[sync] Decoded hex+b64 chapter:', paras.length, 'paras,', paras.join('').length, 'chars');
            return paras;
          }
        }

        // Not HTML — try plain text split
        const lines = text.split(/\n+/).map(s => s.trim()).filter(s => s.length >= 5);
        if (lines.length > 0) return lines;
      } catch (e) {
        console.log('[sync] Base64 decode failed:', e.message);
      }
    }

    // === Try 3: Direct HTML ===
    if (firstChar === '<') {
      const paras = htmlToParagraphs(payload);
      if (paras.length > 0) return paras;
    }

    return [];
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

// ---- WeRead: Search books ----

// Parse search results from a page that's already on the search URL
async function searchWeReadFromCurrentPage(page, keyword) {
  process.stderr.write(`Parsing search results for "${keyword}"...\n`);
  // Wait for book list to render
  await page.waitForSelector('li.wr_bookList_item', { timeout: 10000 }).catch(() => {});
  return _extractSearchResults(page, keyword);
}

async function searchWeRead(page, keyword) {
  const searchUrl = `https://weread.qq.com/web/search/books?keyword=${encodeURIComponent(keyword)}`;
  process.stderr.write(`Searching WeRead for "${keyword}"...\n`);
  await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 60000 });

  // Wait for book list to render (client-side rendered, not in __INITIAL_STATE__)
  await page.waitForSelector('li.wr_bookList_item', { timeout: 10000 }).catch(() => {});

  return _extractSearchResults(page, keyword);
}

async function _extractSearchResults(page, keyword) {
  const results = await page.evaluate(() => {
    const books = [];
    const items = document.querySelectorAll('li.wr_bookList_item');
    items.forEach(item => {
      const titleEl = item.querySelector('p.wr_bookList_item_title');
      const authorEl = item.querySelector('p.wr_bookList_item_author');
      const linkEl = item.querySelector('a.wr_bookList_item_link');
      const descEl = item.querySelector('p.wr_bookList_item_desc');
      const ratingEl = item.querySelector('span.wr_bookList_item_reading_percent');
      const readCountEl = item.querySelector('span.wr_bookList_item_reading_number');
      const coverEl = item.querySelector('img.wr_bookCover_img');

      const title = titleEl?.textContent?.trim() || '';
      if (!title) return;

      const href = linkEl?.getAttribute('href') || '';
      const readerBookId = href.match(/\/web\/reader\/([^/?]+)/)?.[1] || '';

      books.push({
        title,
        author: authorEl?.textContent?.trim() || '',
        readerBookId,
        readerUrl: readerBookId ? `https://weread.qq.com/web/reader/${readerBookId}` : '',
        cover: coverEl?.src || '',
        intro: (descEl?.textContent?.trim() || '').substring(0, 200),
        rating: ratingEl?.textContent?.trim() || '',
        readCount: readCountEl?.textContent?.trim() || '',
      });
    });
    return books;
  });

  // Also grab total count from header
  const totalCount = await page.evaluate(() => {
    const header = document.querySelector('p.search_bookDetail_header_detail');
    return header?.textContent?.trim() || '';
  });

  const top = results.slice(0, 10);
  process.stderr.write(`Found ${results.length} results (${totalCount}), returning top ${top.length}.\n`);
  console.log(JSON.stringify({ event: 'search_results', keyword, totalCount, books: top }));
  return { searched: true, keyword, resultCount: top.length };
}

// ---- WeRead: Add book to shelf ----

async function addToWeReadShelf(page, readerBookId) {
  const readerUrl = `https://weread.qq.com/web/reader/${readerBookId}`;
  // Only navigate if not already on the book page
  if (!page.url().includes(readerBookId)) {
    process.stderr.write(`Opening book page: ${readerUrl}...\n`);
    await page.goto(readerUrl, { waitUntil: 'networkidle2', timeout: 60000 });
  }
  // Wait for reader UI to render (replaced sleep(5000) with targeted wait)
  await page.waitForSelector('button.readerTopBar_addToShelf, svg.readerTopBar_addToShelf_icon', { timeout: 10000 }).catch(() => {});

  // Get book info from __INITIAL_STATE__ and check shelf status via CSS class + button text
  const bookInfo = await page.evaluate(() => {
    const state = window.__INITIAL_STATE__;
    const reader = state?.reader || {};
    const info = reader.bookInfo || {};
    // Shelf status: the top-bar icon has class "added" when book is on shelf,
    // or the button text is NOT "加入书架" (already shelved books show no text or different text)
    const addedIcon = document.querySelector('svg.readerTopBar_addToShelf_icon.added');
    const addBtn = document.querySelector('button.readerTopBar_addToShelf');
    const btnText = addBtn?.textContent?.trim() || '';
    const isInShelf = !!addedIcon || (addBtn && !btnText.includes('加入书架'));
    return {
      title: info.title || document.title || '',
      bookId: reader.bookId || info.bookId || '',
      isInShelf,
    };
  });

  process.stderr.write(`  Book: "${bookInfo.title}", isInShelf: ${bookInfo.isInShelf}\n`);

  if (bookInfo.isInShelf) {
    console.log(JSON.stringify({
      event: 'added_to_shelf',
      title: bookInfo.title,
      bookId: bookInfo.bookId,
      readerBookId,
      alreadyOnShelf: true,
    }));
    return { added: true, alreadyOnShelf: true, title: bookInfo.title };
  }

  // Click the add-to-shelf button in the top bar (Puppeteer real click for isTrusted)
  let clicked = false;
  const addShelfBtn = await page.$('button.readerTopBar_addToShelf');
  if (addShelfBtn) {
    await addShelfBtn.click();
    clicked = true;
    process.stderr.write('  Clicked top-bar "加入书架" button.\n');
  }

  // Fallback: try the outline panel button
  if (!clicked) {
    const outlineBtn = await page.$('div.wr_outline_book_detail_main_nav_action');
    if (outlineBtn) {
      const btnText = await outlineBtn.evaluate(el => el.textContent?.trim() || '');
      if (btnText.includes('加入书架')) {
        await outlineBtn.click();
        clicked = true;
        process.stderr.write('  Clicked outline panel "加入书架" button.\n');
      }
    }
  }

  if (!clicked) {
    process.stderr.write('  Could not find add-to-shelf button.\n');
  }

  await sleep(3000);

  // Verify: check if the icon now has the "added" class or button text changed
  const afterStatus = await page.evaluate(() => {
    const addedIcon = document.querySelector('svg.readerTopBar_addToShelf_icon.added');
    if (addedIcon) return true;
    // Also check if button text no longer says "加入书架"
    const addBtn = document.querySelector('button.readerTopBar_addToShelf');
    const btnText = addBtn?.textContent?.trim() || '';
    return addBtn && !btnText.includes('加入书架');
  });

  process.stderr.write(`  After click: isInShelf = ${afterStatus}\n`);

  console.log(JSON.stringify({
    event: 'added_to_shelf',
    title: bookInfo.title,
    bookId: bookInfo.bookId,
    readerBookId,
    alreadyOnShelf: false,
    success: afterStatus,
  }));

  return { added: afterStatus, alreadyOnShelf: false, title: bookInfo.title };
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

    // Switch to scroll (single-column) mode for reliable content extraction.
    // In scroll mode, preRenderContainers have actual HTML text in DOM.
    // In pagination mode, content is Canvas-only (DOM cleared after render).
    const isPagination = await page.evaluate(() => {
      return !!(document.querySelector('.renderTarget_pager_button') ||
                document.querySelector('.readerControls_item.isHorizontalReader'));
    });
    if (isPagination) {
      process.stderr.write(`  Switching to scroll mode...\n`);
      const toggleBtn = await page.$('.readerControls_item.isHorizontalReader');
      if (toggleBtn) {
        await toggleBtn.click();
        await sleep(3000);
        process.stderr.write(`  Switched to scroll mode.\n`);
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

    // Install MutationObserver to capture preRenderContainer content
    await setupPreRenderCapture(page);

    // Sync each chapter: click TOC → scroll through → MutationObserver captures all preRenderContainers
    const chapters = [];

    for (let ch = 0; ch < tocEntries.length; ch++) {
      const chapterTitle = tocEntries[ch];
      process.stderr.write(`  [${ch + 1}/${tocEntries.length}] ${chapterTitle}...`);

      // Re-open TOC panel if closed
      if (ch > 0) {
        await openWeReadToc(page);
        await sleep(300);
      }

      // Reset capture buffer before navigating
      await page.evaluate(() => { window.__wrCapturedChapters = []; });

      // Click the TOC entry with Puppeteer (isTrusted: true)
      const clicked = await clickWeReadTocEntry(page, tocSelector, ch);
      if (!clicked) {
        process.stderr.write(` skip (click failed)\n`);
        continue;
      }

      // Close TOC panel so it doesn't block content rendering
      await sleep(500);
      await page.keyboard.press('Escape');

      // Wait for initial preRenderContainer capture
      const pollStart = Date.now();
      while (Date.now() - pollStart < 8000) {
        await sleep(300);
        const captured = await readCapturedContent(page);
        if (captured.length > 0) break;
      }

      // Click "下一页" (next page) repeatedly until no more pages
      // WeRead splits long chapters into multiple pages in scroll mode
      let pageNum = 1;
      while (pageNum < 100) { // safety limit
        // Scroll to bottom to reveal the "下一页" button
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await sleep(500);

        // Check for "下一页" button
        const nextBtn = await page.$('button.readerFooter_button');
        if (!nextBtn) break;

        const btnText = await nextBtn.evaluate(el => el.textContent?.trim());
        if (!btnText || !btnText.includes('下一页')) break;

        // Click it
        const prevCount = (await readCapturedContent(page)).length;
        await nextBtn.click();
        pageNum++;

        // Wait for new preRenderContainer to appear
        const pageStart = Date.now();
        while (Date.now() - pageStart < 8000) {
          await sleep(300);
          const current = await readCapturedContent(page);
          if (current.length > prevCount) break;
        }
        await sleep(500);
      }

      // Final read of all captured content across all pages
      const paragraphs = await readCapturedContent(page);

      if (paragraphs.length > 0) {
        chapters.push({ title: chapterTitle, paragraphs });
        const totalChars = paragraphs.join('').length;
        const pageInfo = pageNum > 1 ? ` (${pageNum} pages)` : '';
        process.stderr.write(` ${paragraphs.length} paras, ${totalChars} chars${pageInfo}\n`);
      } else {
        process.stderr.write(` no content\n`);
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

    // Save directly to filesystem (no sync-server needed)
    try {
      const bookDir = path.join(LIBRARY_PATH, 'books', dirId);
      fs.mkdirSync(bookDir, { recursive: true });
      for (const f of files) {
        const filePath = path.join(LIBRARY_PATH, f.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, f.content, 'utf-8');
      }

      // Update index.json
      const indexPath = path.join(LIBRARY_PATH, 'index.json');
      let index = { version: '1.0.0', books: [], updatedAt: '' };
      try {
        if (fs.existsSync(indexPath)) {
          index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        }
      } catch {}
      const existingIdx = index.books.findIndex(b => b.id === dirId);
      if (existingIdx >= 0) index.books[existingIdx] = { id: dirId, ...meta };
      else index.books.push({ id: dirId, ...meta });
      index.updatedAt = new Date().toISOString();
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8');

      booksSynced++;
      process.stderr.write(`  ✓ "${bookMeta.title}" — ${chapters.length} chapters, ${totalChars.toLocaleString()} chars\n`);
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
    console.error('       node scripts/sync-books.js weread --search "keyword"');
    console.error('       node scripts/sync-books.js weread --add-shelf "readerBookId"');
    console.error('');
    console.error('Examples:');
    console.error('  node scripts/sync-books.js kindle              # Sync all Kindle books');
    console.error('  node scripts/sync-books.js kindle --max 3      # Sync at most 3 books');
    console.error('  node scripts/sync-books.js kindle --list        # List books without syncing');
    console.error('  node scripts/sync-books.js kindle --book "书名"  # Sync only the matching book');
    console.error('  node scripts/sync-books.js weread               # Sync from WeRead');
    console.error('  node scripts/sync-books.js weread --search "三体" # Search WeRead for a book');
    console.error('  node scripts/sync-books.js weread --add-shelf "abc123" # Add book to WeRead shelf');
    process.exit(1);
  }

  const maxIdx = args.indexOf('--max');
  const maxBooks = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : 0;
  const listOnly = args.includes('--list');
  const bookIdx = args.indexOf('--book');
  const bookFilter = bookIdx >= 0 ? args[bookIdx + 1] : null;
  const searchIdx = args.indexOf('--search');
  const searchKeyword = searchIdx >= 0 ? args[searchIdx + 1] : null;
  const addShelfIdx = args.indexOf('--add-shelf');
  const addShelfId = addShelfIdx >= 0 ? args[addShelfIdx + 1] : null;
  const emailIdx = args.indexOf('--email');
  const passwordIdx = args.indexOf('--password');
  const credentials = (emailIdx >= 0 && passwordIdx >= 0)
    ? { email: args[emailIdx + 1], password: args[passwordIdx + 1] }
    : null;

  // Step 0: Auto-setup — install dependencies + build extension if needed
  ensureDependencies();

  // Search and add-shelf don't need the extension — skip extension build/load for speed
  const needsExtension = !searchKeyword && !addShelfId;
  const extPath = needsExtension ? ensureExtensionBuilt() : null;

  // Ensure library directory exists
  fs.mkdirSync(LIBRARY_PATH, { recursive: true });

  let browser;
  try {
    // Launch Chrome — with extension only when needed (sync needs it, search/add-shelf don't)
    if (needsExtension) {
      browser = await launchChrome(extPath);
    } else {
      // Lightweight Chrome launch without extension
      process.stderr.write('Launching Chrome (no extension needed)...\n');
      browser = await puppeteer.launch({
        headless: false,
        protocolTimeout: 600_000,
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-popup-blocking',
        ],
        userDataDir: CHROME_PROFILE,
      });
    }
    _activeBrowser = browser;

    let extId = null;
    if (needsExtension) {
      // Find extension (only needed for sync)
      process.stderr.write('Finding CastReader extension...\n');
      extId = await findExtensionId(browser);
      process.stderr.write(`Extension ID: ${extId}\n`);
    }

    // Navigate to initial page
    const page = await browser.newPage();
    const isKindle = source === 'kindle';
    await page.setViewport({ width: isKindle ? 1920 : 1280, height: isKindle ? 2400 : 900 });

    // Navigate directly to the target page (skip shelf for search — saves ~8s)
    const initialUrl = searchKeyword
      ? `https://weread.qq.com/web/search/books?keyword=${encodeURIComponent(searchKeyword)}`
      : addShelfId
      ? `https://weread.qq.com/web/reader/${addShelfId}`
      : (isKindle ? 'https://read.amazon.com/kindle-library' : 'https://weread.qq.com/web/shelf');
    process.stderr.write(`Navigating to ${initialUrl}...\n`);
    await page.goto(initialUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // Step 5: Source-specific flow
    let result;

    if (source === 'weread' && searchKeyword) {
      // WeRead search flow: already navigated directly to search URL
      // Check if login is needed (redirected away from search page)
      const currentUrl = page.url();
      if (!currentUrl.includes('/web/search/')) {
        // Got redirected — need login. Go to shelf for login flow.
        await page.goto('https://weread.qq.com/web/shelf', { waitUntil: 'networkidle2', timeout: 60000 });
        const loggedIn = await waitForLogin(page, 'weread');
        if (!loggedIn) { console.error('Login timed out.'); process.exit(1); }
        // Now navigate to search
        result = await searchWeRead(page, searchKeyword);
      } else {
        // Already on search page — just parse results
        result = await searchWeReadFromCurrentPage(page, searchKeyword);
      }
    } else if (source === 'weread' && addShelfId) {
      // WeRead add-to-shelf flow: already navigated directly to book page
      result = await addToWeReadShelf(page, addShelfId);
    } else if (source === 'kindle') {
      result = await syncKindle(browser, extId, page, maxBooks, { listOnly, bookFilter, credentials });
    } else {
      result = await syncWeRead(browser, extId, page, maxBooks, { listOnly, bookFilter });
    }

    // Output result (search/add-shelf already output their own JSON)
    if (!searchKeyword && !addShelfId) {
      console.log(JSON.stringify({
        success: true,
        source,
        ...result,
        libraryPath: LIBRARY_PATH,
      }));
    }

  } finally {
    _activeBrowser = null;
    if (browser) {
      process.stderr.write('\nSync complete. Closing browser...\n');
      await browser.close().catch(() => {});
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
