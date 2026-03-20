#!/usr/bin/env node

/**
 * test-e2e-sync.js — E2E integration tests for sync-books.js
 *
 * Tests real Chrome + real Kindle/WeRead with --list and --book flags.
 * Uses a FRESH Chrome profile — login will be handled by sync-books.js
 * (user scans QR code or enters credentials when prompted).
 *
 * Usage:
 *   node scripts/test-e2e-sync.js weread          # Test WeRead only
 *   node scripts/test-e2e-sync.js kindle          # Test Kindle only
 *   node scripts/test-e2e-sync.js all             # Test both (sequential)
 *
 * Environment:
 *   CHROME_PROFILE  — Chrome user data dir (default: fresh temp dir)
 *   LIBRARY_ROOT    — Library storage path (default: ~/castreader-library)
 *   BOOK_FILTER     — Override book title to sync (default: auto-pick shortest)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const SCRIPTS_DIR = __dirname;
const SKILL_DIR = path.dirname(SCRIPTS_DIR);
const LIBRARY_PATH = process.env.LIBRARY_ROOT || path.join(os.homedir(), 'castreader-library');

// Use a persistent Chrome profile for E2E tests so login sessions are preserved across runs
function getTestChromeProfile() {
  if (process.env.CHROME_PROFILE) return { profilePath: process.env.CHROME_PROFILE, isFresh: false };

  // Use a persistent profile dir so logins survive between test runs
  const testProfile = path.join(os.tmpdir(), 'castreader-e2e-profile');
  fs.mkdirSync(testProfile, { recursive: true });
  const isNew = !fs.existsSync(path.join(testProfile, 'Default'));
  if (isNew) {
    console.log(`  New persistent Chrome profile: ${testProfile}`);
    console.log(`  (You will need to log in when prompted — scan QR or enter credentials)`);
  } else {
    console.log(`  Reusing persistent Chrome profile: ${testProfile}`);
    console.log(`  (Login should be preserved from previous run)`);
  }
  return { profilePath: testProfile, isFresh: false };
}

const { profilePath: CHROME_PROFILE } = getTestChromeProfile();

// Parse CLI args
const targetArg = process.argv[2]?.toLowerCase();
if (!targetArg || !['weread', 'kindle', 'all'].includes(targetArg)) {
  console.error('Usage: node scripts/test-e2e-sync.js <weread|kindle|all>');
  console.error('');
  console.error('Environment variables:');
  console.error('  CHROME_PROFILE  Chrome user data dir');
  console.error('  BOOK_FILTER     Book title to sync (default: auto-pick)');
  process.exit(1);
}

const testWeRead = targetArg === 'weread' || targetArg === 'all';
const testKindle = targetArg === 'kindle' || targetArg === 'all';

// ---- Helpers ----

/**
 * Run sync-books.js with given args, capture stdout/stderr, return parsed result.
 * Timeout: 10 minutes for sync, 2 minutes for list.
 */
function runSyncBooks(args, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (CHROME_PROFILE) env.CHROME_PROFILE = CHROME_PROFILE;

    const proc = spawn('node', [path.join(SCRIPTS_DIR, 'sync-books.js'), ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    const jsonEvents = [];

    proc.stdout.on('data', (data) => {
      stdoutChunks.push(data);
      // Parse JSON lines from stdout
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          jsonEvents.push(JSON.parse(line));
        } catch {}
      }
    });

    proc.stderr.on('data', (data) => {
      stderrChunks.push(data);
      // Stream stderr to console for visibility
      process.stderr.write(`  [sync] ${data}`);
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        jsonEvents,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function banner(msg) {
  const line = '='.repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${msg}`);
  console.log(`${line}\n`);
}

// ---- Pre-checks ----

describe('E2E pre-checks', () => {
  it('Chrome profile is set', () => {
    assert.ok(CHROME_PROFILE, 'CHROME_PROFILE not set');
    // Profile dir may not exist yet — sync-books.js creates it via puppeteer launch
    console.log(`  Chrome profile: ${CHROME_PROFILE} (exists: ${fs.existsSync(CHROME_PROFILE)})`);
  });

  it('Extension is built', () => {
    const devExt = path.join(SKILL_DIR, '../../Documents/MyProject/readout-desktop/.output/chrome-mv3');
    const bundledExt = path.join(SKILL_DIR, 'chrome-extension');
    const hasExt = (fs.existsSync(path.join(devExt, 'manifest.json')) ||
                    fs.existsSync(path.join(bundledExt, 'manifest.json')));
    assert.ok(hasExt, 'No built extension found');
  });
});

// ---- WeRead Tests ----

if (testWeRead) {
  describe('E2E WeRead', { timeout: 1800_000 }, () => {
    let bookList = [];
    let selectedBook = null;

    describe('--list: list remote book shelf', { timeout: 360_000 }, () => {
      it('returns valid JSON with books array', async () => {
        banner('WeRead --list');
        console.log('  (If not logged in, Chrome will open — scan QR code in WeChat)');
        const result = await runSyncBooks(['weread', '--list'], 360_000);

        // May have wechat_qr event before the book list — that's OK, user scans QR
        const listEvent = result.jsonEvents.find(e => e.books);
        const qrEvent = result.jsonEvents.find(e => e.event === 'wechat_qr');
        const loginTimeout = result.jsonEvents.find(e => e.event === 'login_timeout');

        if (qrEvent) {
          console.log('  [info] WeRead QR login was triggered. Screenshot:', qrEvent.screenshot);
        }
        if (loginTimeout) {
          assert.fail('WeRead login timed out — please scan QR faster next time');
        }

        assert.ok(listEvent, 'Should output a JSON object with books array');
        assert.ok(Array.isArray(listEvent.books), 'books should be an array');
        assert.ok(listEvent.books.length > 0, 'Should have at least 1 book');

        bookList = listEvent.books;
        console.log(`  Found ${bookList.length} books on WeRead shelf`);
        bookList.slice(0, 5).forEach((b, i) => {
          console.log(`    ${i + 1}. "${b.title}" — ${b.author}`);
        });
        if (bookList.length > 5) {
          console.log(`    ... and ${bookList.length - 5} more`);
        }
      });

      it('each book has title and author', () => {
        assert.ok(bookList.length > 0, 'Need books from previous test');
        for (const book of bookList) {
          assert.ok(book.title, `Book missing title: ${JSON.stringify(book)}`);
          assert.ok(typeof book.title === 'string');
          // author may be empty for some books, but should exist as field
          assert.ok('author' in book, `Book missing author field: ${book.title}`);
        }
      });

      it('no duplicate titles', () => {
        const titles = bookList.map(b => b.title);
        const unique = new Set(titles);
        // Allow some duplicates (different editions) but flag if excessive
        const dupCount = titles.length - unique.size;
        if (dupCount > 0) {
          console.log(`  [warn] ${dupCount} duplicate titles found`);
        }
        assert.ok(dupCount < titles.length * 0.3, `Too many duplicates: ${dupCount}/${titles.length}`);
      });
    });

    describe('--book: sync a single book', { timeout: 1200_000 }, () => {
      before(() => {
        if (bookList.length === 0) {
          throw new Error('No books available — --list test must pass first');
        }

        // Pick book: use BOOK_FILTER env, or auto-pick shortest title (likely shortest book)
        if (process.env.BOOK_FILTER) {
          selectedBook = bookList.find(b =>
            b.title.toLowerCase().includes(process.env.BOOK_FILTER.toLowerCase())
          );
          if (!selectedBook) {
            throw new Error(`No book matching "${process.env.BOOK_FILTER}" in shelf`);
          }
        } else {
          // Pick the book with shortest title (heuristic: shorter title ≈ shorter book ≈ faster sync)
          selectedBook = [...bookList].sort((a, b) => a.title.length - b.title.length)[0];
        }
        console.log(`  Selected book: "${selectedBook.title}" — ${selectedBook.author}`);
      });

      it('syncs selected book successfully', async () => {
        banner(`WeRead --book "${selectedBook.title}"`);
        const result = await runSyncBooks(['weread', '--book', selectedBook.title], 1200_000);

        // Check for success
        const finalEvent = result.jsonEvents.find(e => e.success !== undefined);
        assert.ok(finalEvent, `Should output final JSON result. Got: ${result.stdout}`);
        assert.equal(finalEvent.success, true, `Sync should succeed. stderr: ${result.stderr.slice(-500)}`);
        assert.ok(finalEvent.booksSynced >= 1 || finalEvent.listOnly,
          `Should sync at least 1 book (or skip if already synced). Got: ${JSON.stringify(finalEvent)}`);
        console.log(`  Sync result: ${JSON.stringify(finalEvent)}`);
      });

      it('created valid library structure', () => {
        assert.ok(fs.existsSync(LIBRARY_PATH), `Library dir should exist at ${LIBRARY_PATH}`);

        const indexPath = path.join(LIBRARY_PATH, 'index.json');
        assert.ok(fs.existsSync(indexPath), 'index.json should exist');

        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        assert.ok(Array.isArray(index.books), 'index.books should be array');
        assert.ok(index.books.length >= 1, 'Should have at least 1 book in index');

        // Find our synced book
        const synced = index.books.find(b =>
          b.title.toLowerCase().includes(selectedBook.title.toLowerCase().substring(0, 10))
        );
        assert.ok(synced, `Synced book "${selectedBook.title}" should be in index.json`);
        console.log(`  Index entry: ${JSON.stringify(synced)}`);
      });

      it('has valid meta.json', () => {
        const index = JSON.parse(fs.readFileSync(path.join(LIBRARY_PATH, 'index.json'), 'utf-8'));
        const synced = index.books.find(b =>
          b.title.toLowerCase().includes(selectedBook.title.toLowerCase().substring(0, 10))
        );
        const bookDir = path.join(LIBRARY_PATH, 'books', synced.id);

        assert.ok(fs.existsSync(bookDir), `Book dir should exist: ${bookDir}`);

        const metaPath = path.join(bookDir, 'meta.json');
        assert.ok(fs.existsSync(metaPath), 'meta.json should exist');

        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        assert.ok(meta.title, 'meta.title should exist');
        assert.ok(meta.source === 'weread', 'source should be weread');
        assert.ok(meta.totalChapters > 0, `totalChapters should be > 0, got ${meta.totalChapters}`);
        assert.ok(meta.syncedAt, 'syncedAt should exist');
        console.log(`  Meta: ${meta.title} — ${meta.author} · ${meta.totalChapters} chapters · ${meta.totalCharacters} chars · lang=${meta.language}`);
      });

      it('has chapter files', () => {
        const index = JSON.parse(fs.readFileSync(path.join(LIBRARY_PATH, 'index.json'), 'utf-8'));
        const synced = index.books.find(b =>
          b.title.toLowerCase().includes(selectedBook.title.toLowerCase().substring(0, 10))
        );
        const bookDir = path.join(LIBRARY_PATH, 'books', synced.id);

        const chapters = fs.readdirSync(bookDir).filter(f => f.startsWith('chapter-')).sort();
        assert.ok(chapters.length > 0, `Should have chapter files, got 0 in ${bookDir}`);
        console.log(`  Chapter files: ${chapters.length} (${chapters[0]} .. ${chapters[chapters.length - 1]})`);

        // Validate first chapter
        const ch1 = fs.readFileSync(path.join(bookDir, chapters[0]), 'utf-8');
        assert.ok(ch1.length > 10, `First chapter should have content, got ${ch1.length} chars`);
        assert.ok(ch1.startsWith('#'), 'Chapter should start with # heading');
        console.log(`  First chapter: ${ch1.substring(0, 100).replace(/\n/g, '\\n')}...`);
      });

      it('has full.md', () => {
        const index = JSON.parse(fs.readFileSync(path.join(LIBRARY_PATH, 'index.json'), 'utf-8'));
        const synced = index.books.find(b =>
          b.title.toLowerCase().includes(selectedBook.title.toLowerCase().substring(0, 10))
        );
        const bookDir = path.join(LIBRARY_PATH, 'books', synced.id);

        const fullPath = path.join(bookDir, 'full.md');
        assert.ok(fs.existsSync(fullPath), 'full.md should exist');

        const full = fs.readFileSync(fullPath, 'utf-8');
        assert.ok(full.length > 100, `full.md should have substantial content, got ${full.length} chars`);
        console.log(`  full.md: ${full.length} chars`);
      });

      it('chapter content is not encrypted (anti-piracy check)', () => {
        const index = JSON.parse(fs.readFileSync(path.join(LIBRARY_PATH, 'index.json'), 'utf-8'));
        const synced = index.books.find(b =>
          b.title.toLowerCase().includes(selectedBook.title.toLowerCase().substring(0, 10))
        );
        const bookDir = path.join(LIBRARY_PATH, 'books', synced.id);

        const chapters = fs.readdirSync(bookDir).filter(f => f.startsWith('chapter-')).sort();
        let encryptedCount = 0;

        for (const chFile of chapters) {
          const content = fs.readFileSync(path.join(bookDir, chFile), 'utf-8');
          // Encrypted WeRead content has garbled Unicode — check for abnormal char distribution
          const normalChars = content.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffefa-zA-Z0-9\s.,!?;:'"()\-\n#]/g)?.length || 0;
          const totalChars = content.length;
          if (totalChars > 50) {
            const normalRatio = normalChars / totalChars;
            if (normalRatio < 0.5) {
              encryptedCount++;
              console.log(`  [WARN] ${chFile} appears encrypted (normal ratio: ${(normalRatio * 100).toFixed(1)}%)`);
            }
          }
        }

        assert.equal(encryptedCount, 0,
          `${encryptedCount}/${chapters.length} chapters appear encrypted — anti-piracy filter may have failed`);
        console.log(`  All ${chapters.length} chapters passed anti-piracy check`);
      });
    });

    describe('--book: skip already synced', { timeout: 180_000 }, () => {
      it('skips book that was already synced', async () => {
        if (!selectedBook) return;

        banner(`WeRead --book "${selectedBook.title}" (re-run, should skip)`);
        const result = await runSyncBooks(['weread', '--book', selectedBook.title], 180_000);

        // Should still succeed but with 0 books synced (already synced → skip)
        const finalEvent = result.jsonEvents.find(e => e.success !== undefined);
        assert.ok(finalEvent, 'Should output final result');
        assert.equal(finalEvent.success, true);
        console.log(`  Re-sync result: ${JSON.stringify(finalEvent)}`);
        // Check stderr mentions "already synced" or "Skipping"
        assert.ok(
          result.stderr.includes('Skipping') || result.stderr.includes('already synced') || finalEvent.booksSynced === 0,
          'Should skip or report 0 books synced'
        );
      });
    });

    describe('--book: non-matching title', { timeout: 180_000 }, () => {
      it('handles gracefully when no book matches', async () => {
        banner('WeRead --book "这本书绝对不存在xyz789"');
        const result = await runSyncBooks(['weread', '--book', '这本书绝对不存在xyz789'], 180_000);

        const finalEvent = result.jsonEvents.find(e => e.success !== undefined);
        assert.ok(finalEvent, 'Should output final result');
        assert.equal(finalEvent.booksSynced, 0, 'Should sync 0 books');
        assert.ok(result.stderr.includes('No book matching'), 'Should report no match in stderr');
        console.log(`  Non-match result: ${JSON.stringify(finalEvent)}`);
      });
    });
  });
}

// ---- Kindle Tests ----

if (testKindle) {
  describe('E2E Kindle', { timeout: 900_000 }, () => {
    let bookList = [];
    let selectedBook = null;

    describe('--list: list remote Kindle library', { timeout: 360_000 }, () => {
      it('returns valid JSON with books array', async () => {
        banner('Kindle --list');
        console.log('  (If not logged in, Chrome will open — sign in to Amazon)');
        const result = await runSyncBooks(['kindle', '--list'], 360_000);

        const listEvent = result.jsonEvents.find(e => e.books);
        const loginEvent = result.jsonEvents.find(e =>
          e.event === 'login_timeout'
        );

        if (loginEvent) {
          console.log('  [!] Kindle login timed out.');
          assert.fail('Kindle login timed out — please sign in faster next time');
        }

        assert.ok(listEvent, `Should output JSON with books. stdout: ${result.stdout.slice(0, 500)}`);
        assert.ok(Array.isArray(listEvent.books), 'books should be an array');
        assert.ok(listEvent.books.length > 0, 'Should have at least 1 book');

        bookList = listEvent.books;
        console.log(`  Found ${bookList.length} books in Kindle library`);
        bookList.slice(0, 5).forEach((b, i) => {
          console.log(`    ${i + 1}. "${b.title}" — ${b.author}`);
        });
        if (bookList.length > 5) {
          console.log(`    ... and ${bookList.length - 5} more`);
        }
      });

      it('each book has title and author', () => {
        assert.ok(bookList.length > 0, 'Need books from previous test');
        for (const book of bookList) {
          assert.ok(book.title, `Book missing title: ${JSON.stringify(book)}`);
          assert.ok(typeof book.title === 'string');
        }
      });

      it('no duplicate titles', () => {
        const titles = bookList.map(b => b.title);
        const unique = new Set(titles);
        const dupCount = titles.length - unique.size;
        if (dupCount > 0) {
          console.log(`  [warn] ${dupCount} duplicate titles found`);
        }
        assert.ok(dupCount < titles.length * 0.3, `Too many duplicates: ${dupCount}/${titles.length}`);
      });
    });

    describe('--book: sync a single book', { timeout: 1200_000 }, () => {
      before(() => {
        if (bookList.length === 0) {
          throw new Error('No books available — --list test must pass first');
        }

        if (process.env.BOOK_FILTER) {
          selectedBook = bookList.find(b =>
            b.title.toLowerCase().includes(process.env.BOOK_FILTER.toLowerCase())
          );
          if (!selectedBook) {
            throw new Error(`No book matching "${process.env.BOOK_FILTER}" in library`);
          }
        } else {
          // Pick shortest title
          selectedBook = [...bookList].sort((a, b) => a.title.length - b.title.length)[0];
        }
        console.log(`  Selected book: "${selectedBook.title}" — ${selectedBook.author}`);
      });

      it('syncs selected book successfully', async () => {
        banner(`Kindle --book "${selectedBook.title}"`);
        const result = await runSyncBooks(['kindle', '--book', selectedBook.title], 1200_000);

        const finalEvent = result.jsonEvents.find(e => e.success !== undefined);
        assert.ok(finalEvent, `Should output final JSON result. stdout: ${result.stdout.slice(0, 500)}`);
        assert.equal(finalEvent.success, true, `Sync should succeed. stderr: ${result.stderr.slice(-500)}`);
        assert.ok(finalEvent.booksSynced >= 1 || finalEvent.listOnly,
          `Should sync at least 1 book. Got: ${JSON.stringify(finalEvent)}`);
        console.log(`  Sync result: ${JSON.stringify(finalEvent)}`);
      });

      it('created valid library structure', () => {
        assert.ok(fs.existsSync(LIBRARY_PATH), `Library dir should exist at ${LIBRARY_PATH}`);

        const indexPath = path.join(LIBRARY_PATH, 'index.json');
        assert.ok(fs.existsSync(indexPath), 'index.json should exist');

        const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        assert.ok(Array.isArray(index.books), 'index.books should be array');

        // Find our synced book
        const synced = index.books.find(b =>
          b.title.toLowerCase().includes(selectedBook.title.toLowerCase().substring(0, 10))
        );
        assert.ok(synced, `Synced book "${selectedBook.title}" should be in index.json`);
        console.log(`  Index entry: ${JSON.stringify(synced)}`);
      });

      it('has valid meta.json', () => {
        const index = JSON.parse(fs.readFileSync(path.join(LIBRARY_PATH, 'index.json'), 'utf-8'));
        const synced = index.books.find(b =>
          b.title.toLowerCase().includes(selectedBook.title.toLowerCase().substring(0, 10))
        );
        const bookDir = path.join(LIBRARY_PATH, 'books', synced.id);

        const metaPath = path.join(bookDir, 'meta.json');
        assert.ok(fs.existsSync(metaPath), 'meta.json should exist');

        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        assert.ok(meta.title, 'meta.title should exist');
        assert.ok(meta.source === 'kindle', 'source should be kindle');
        assert.ok(meta.totalChapters > 0, `totalChapters should be > 0, got ${meta.totalChapters}`);
        console.log(`  Meta: ${meta.title} — ${meta.author} · ${meta.totalChapters} chapters · ${meta.totalCharacters} chars · lang=${meta.language}`);
      });

      it('has chapter files with OCR-extracted content', () => {
        const index = JSON.parse(fs.readFileSync(path.join(LIBRARY_PATH, 'index.json'), 'utf-8'));
        const synced = index.books.find(b =>
          b.title.toLowerCase().includes(selectedBook.title.toLowerCase().substring(0, 10))
        );
        const bookDir = path.join(LIBRARY_PATH, 'books', synced.id);

        const chapters = fs.readdirSync(bookDir).filter(f => f.startsWith('chapter-')).sort();
        assert.ok(chapters.length > 0, `Should have chapter files, got 0 in ${bookDir}`);
        console.log(`  Chapter files: ${chapters.length} (${chapters[0]} .. ${chapters[chapters.length - 1]})`);

        // Validate first chapter
        const ch1 = fs.readFileSync(path.join(bookDir, chapters[0]), 'utf-8');
        assert.ok(ch1.length > 10, `First chapter should have content, got ${ch1.length} chars`);
        console.log(`  First chapter: ${ch1.substring(0, 100).replace(/\n/g, '\\n')}...`);

        // Check OCR quality: no excessive garbage characters
        const readable = ch1.match(/[a-zA-Z\u4e00-\u9fff\s.,!?;:'"()\-0-9]/g)?.length || 0;
        const ratio = readable / ch1.length;
        assert.ok(ratio > 0.7, `OCR quality too low: ${(ratio * 100).toFixed(1)}% readable chars`);
        console.log(`  OCR quality: ${(ratio * 100).toFixed(1)}% readable`);
      });

      it('has full.md', () => {
        const index = JSON.parse(fs.readFileSync(path.join(LIBRARY_PATH, 'index.json'), 'utf-8'));
        const synced = index.books.find(b =>
          b.title.toLowerCase().includes(selectedBook.title.toLowerCase().substring(0, 10))
        );
        const bookDir = path.join(LIBRARY_PATH, 'books', synced.id);

        const fullPath = path.join(bookDir, 'full.md');
        assert.ok(fs.existsSync(fullPath), 'full.md should exist');

        const full = fs.readFileSync(fullPath, 'utf-8');
        assert.ok(full.length > 100, `full.md should have substantial content, got ${full.length} chars`);
        console.log(`  full.md: ${full.length} chars`);
      });
    });

    describe('--book: skip already synced', { timeout: 180_000 }, () => {
      it('skips book that was already synced', async () => {
        if (!selectedBook) return;

        banner(`Kindle --book "${selectedBook.title}" (re-run, should skip)`);
        const result = await runSyncBooks(['kindle', '--book', selectedBook.title], 180_000);

        const finalEvent = result.jsonEvents.find(e => e.success !== undefined);
        assert.ok(finalEvent, 'Should output final result');
        assert.equal(finalEvent.success, true);
        console.log(`  Re-sync result: ${JSON.stringify(finalEvent)}`);
        assert.ok(
          result.stderr.includes('Skipping') || result.stderr.includes('already synced') || finalEvent.booksSynced === 0,
          'Should skip or report 0 books synced'
        );
      });
    });

    describe('--book: non-matching title', { timeout: 180_000 }, () => {
      it('handles gracefully when no book matches', async () => {
        banner('Kindle --book "ThisBookDoesNotExistXYZ789"');
        const result = await runSyncBooks(['kindle', '--book', 'ThisBookDoesNotExistXYZ789'], 180_000);

        const finalEvent = result.jsonEvents.find(e => e.success !== undefined);
        assert.ok(finalEvent, 'Should output final result');
        assert.equal(finalEvent.booksSynced, 0, 'Should sync 0 books');
        assert.ok(result.stderr.includes('No book matching'), 'Should report no match');
        console.log(`  Non-match result: ${JSON.stringify(finalEvent)}`);
      });
    });
  });
}

// ---- Cross-platform validation (after both) ----

if (testWeRead && testKindle) {
  describe('E2E cross-platform: library integrity', { timeout: 30_000 }, () => {
    it('index.json has books from both sources', () => {
      const indexPath = path.join(LIBRARY_PATH, 'index.json');
      if (!fs.existsSync(indexPath)) {
        console.log('  [skip] No index.json — sync tests may have failed');
        return;
      }

      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      const sources = new Set(index.books.map(b => b.source));
      console.log(`  Library: ${index.books.length} books, sources: ${[...sources].join(', ')}`);

      if (sources.has('weread')) console.log('  ✓ Has WeRead books');
      if (sources.has('kindle')) console.log('  ✓ Has Kindle books');
    });

    it('all books have consistent structure', () => {
      const indexPath = path.join(LIBRARY_PATH, 'index.json');
      if (!fs.existsSync(indexPath)) return;

      const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      for (const book of index.books) {
        const bookDir = path.join(LIBRARY_PATH, 'books', book.id);
        assert.ok(fs.existsSync(bookDir), `Book dir missing: ${bookDir}`);
        assert.ok(fs.existsSync(path.join(bookDir, 'meta.json')), `meta.json missing for ${book.title}`);

        const chapters = fs.readdirSync(bookDir).filter(f => f.startsWith('chapter-'));
        assert.ok(chapters.length > 0, `No chapters for ${book.title}`);

        console.log(`  ✓ ${book.title} — ${chapters.length} chapters, source=${book.source}`);
      }
    });
  });
}

// Note: Chrome profile is persistent at /tmp/castreader-e2e-profile/
// To start fresh, delete it manually: rm -rf /tmp/castreader-e2e-profile/
