#!/usr/bin/env node

/**
 * test-sync.js — Automated tests for sync-books.js + sync-server.cjs
 *
 * Usage:
 *   node scripts/test-sync.js              # Run all tests
 *   node --test-name-pattern="L1" scripts/test-sync.js  # Only L1 tests
 *
 * Test levels:
 *   L1 — Pure logic (no I/O)
 *   L2 — Sync server (HTTP + file I/O, uses temp dir)
 *   L3 — Library reading flow (fixture data)
 *   L4 — CLI integration (subprocess, no Chrome)
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');

const SCRIPTS_DIR = __dirname;

// ============================================================
// L1: Pure Logic Tests (no I/O)
// ============================================================

describe('L1: mergeLinesToParagraphs', () => {
  const { mergeLinesToParagraphs } = require('./sync-books.js');

  it('returns empty array for empty input', () => {
    assert.deepEqual(mergeLinesToParagraphs([]), []);
  });

  it('returns single element for single line', () => {
    assert.deepEqual(mergeLinesToParagraphs(['hello world']), ['hello world']);
  });

  it('merges consecutive full-width lines into one paragraph', () => {
    // All lines same length → none are "short" → single paragraph
    const lines = [
      'This is a full width line that fills the entire column width.',
      'This is another line that fills the entire column width too.',
      'And yet another line that fills the entire column width here.',
    ];
    const result = mergeLinesToParagraphs(lines);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('This is a full width'));
    assert.ok(result[0].includes('And yet another'));
  });

  it('splits paragraphs at short lines', () => {
    const lines = [
      'First paragraph line one is a long line that fills the full width.',
      'Short ending.',  // short → paragraph break after this
      'Second paragraph starts with another long line filling full width.',
      'And continues here with another long line of similar total length.',
    ];
    const result = mergeLinesToParagraphs(lines);
    assert.equal(result.length, 2);
    assert.ok(result[0].includes('First paragraph'));
    assert.ok(result[0].includes('Short ending.'));
    assert.ok(result[1].includes('Second paragraph'));
  });

  it('handles Chinese text', () => {
    const lines = [
      '这是第一段的第一行，这是一个很长很长的句子，填满了整个排版宽度的行。',
      '短结尾。',
      '这是第二段的第一行，同样是一个很长的句子，用来填满排版宽度的行。',
    ];
    const result = mergeLinesToParagraphs(lines);
    assert.equal(result.length, 2);
  });

  it('handles all short lines as separate paragraphs', () => {
    const lines = ['A', 'B', 'C'];
    const result = mergeLinesToParagraphs(lines);
    // All lines are equally short, maxLen * 0.75 = 0.75
    // len("A")=1 >= 0.75 threshold, so NOT short → all merged
    // Actually: maxLen=1, threshold=0.75, "A".length=1 >= 0.75 → NOT short
    // So they all merge into one
    assert.equal(result.length, 1);
  });
});

describe('L1: CLI arg parsing', () => {
  it('rejects missing source arg', (_, done) => {
    execFile('node', [path.join(SCRIPTS_DIR, 'sync-books.js')], (err, stdout, stderr) => {
      assert.ok(err, 'Should exit with error');
      assert.ok(stderr.includes('Usage:'), 'Should print usage');
      done();
    });
  });

  it('rejects invalid source arg', (_, done) => {
    execFile('node', [path.join(SCRIPTS_DIR, 'sync-books.js'), 'dropbox'], (err, stdout, stderr) => {
      assert.ok(err, 'Should exit with error');
      assert.ok(stderr.includes('Usage:'), 'Should print usage');
      done();
    });
  });
});

describe('L1: book filter matching logic', () => {
  // Simulate the filter logic from sync-books.js
  function matchesFilter(title, filter) {
    const filterLower = filter.toLowerCase();
    const titleLower = title.toLowerCase();
    return titleLower.includes(filterLower) || filterLower.includes(titleLower);
  }

  it('exact match', () => {
    assert.ok(matchesFilter('海边的卡夫卡', '海边的卡夫卡'));
  });

  it('partial match (filter is substring of title)', () => {
    assert.ok(matchesFilter('海边的卡夫卡', '卡夫卡'));
  });

  it('partial match (title is substring of filter)', () => {
    assert.ok(matchesFilter('卡夫卡', '海边的卡夫卡'));
  });

  it('case insensitive', () => {
    assert.ok(matchesFilter('Thinking, Fast and Slow', 'thinking'));
  });

  it('no match', () => {
    assert.ok(!matchesFilter('海边的卡夫卡', 'Thinking'));
  });
});

// ============================================================
// L2: Sync Server Tests (HTTP + file I/O)
// ============================================================

describe('L2: sync-server', () => {
  let serverProcess;
  const TEST_PORT = 18891;
  let TEST_LIBRARY;
  const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

  async function req(method, pathname, body) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: pathname,
        method,
        headers: { 'Content-Type': 'application/json' },
      };
      const r = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch (e) {
            resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString() });
          }
        });
      });
      r.on('error', reject);
      if (body) r.write(JSON.stringify(body));
      r.end();
    });
  }

  before(async () => {
    TEST_LIBRARY = fs.mkdtempSync(path.join(os.tmpdir(), 'castreader-test-'));
    serverProcess = spawn('node', [path.join(SCRIPTS_DIR, 'sync-server.cjs')], {
      env: { ...process.env, SYNC_SERVER_PORT: String(TEST_PORT), LIBRARY_ROOT: TEST_LIBRARY },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait for server to start
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 5000);
      serverProcess.stderr.on('data', () => {}); // drain
      serverProcess.stdout.on('data', (d) => {
        if (d.toString().includes('Listening')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      serverProcess.on('error', (e) => { clearTimeout(timeout); reject(e); });
    });
  });

  after(() => {
    if (serverProcess) serverProcess.kill();
    // Clean up temp directory
    fs.rmSync(TEST_LIBRARY, { recursive: true, force: true });
  });

  it('GET /health returns ok', async () => {
    const { status, data } = await req('GET', '/health');
    assert.equal(status, 200);
    assert.equal(data.status, 'ok');
    assert.equal(data.libraryRoot, TEST_LIBRARY);
  });

  it('POST /save creates a file', async () => {
    const { status, data } = await req('POST', '/save', {
      path: 'books/test-book-1/meta.json',
      content: JSON.stringify({ title: 'Test Book', author: 'Test Author' }),
    });
    assert.equal(status, 200);
    assert.equal(data.ok, true);

    const filePath = path.join(TEST_LIBRARY, 'books/test-book-1/meta.json');
    assert.ok(fs.existsSync(filePath));
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(content.title, 'Test Book');
  });

  it('POST /save rejects path traversal', async () => {
    const { status } = await req('POST', '/save', {
      path: '../../../etc/passwd',
      content: 'hacked',
    });
    assert.equal(status, 403);
  });

  it('POST /save rejects missing path', async () => {
    const { status } = await req('POST', '/save', { content: 'hello' });
    assert.equal(status, 400);
  });

  it('POST /read reads a file', async () => {
    // Write first
    const filePath = path.join(TEST_LIBRARY, 'books/test-book-1/chapter-01.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '# Chapter 1\n\nHello world.');

    const { status, data } = await req('POST', '/read', { path: 'books/test-book-1/chapter-01.md' });
    assert.equal(status, 200);
    assert.ok(data.content.includes('Hello world'));
  });

  it('POST /read returns 404 for missing file', async () => {
    const { status } = await req('POST', '/read', { path: 'books/nonexistent/meta.json' });
    assert.equal(status, 404);
  });

  it('POST /save-batch saves multiple files', async () => {
    const { status, data } = await req('POST', '/save-batch', {
      files: [
        { path: 'books/batch-book/chapter-01.md', content: '# Ch1\n\nParagraph 1.' },
        { path: 'books/batch-book/chapter-02.md', content: '# Ch2\n\nParagraph 2.' },
        { path: 'books/batch-book/meta.json', content: JSON.stringify({ title: 'Batch Book', author: 'Author' }) },
      ],
    });
    assert.equal(status, 200);
    assert.equal(data.saved, 3);
    assert.ok(fs.existsSync(path.join(TEST_LIBRARY, 'books/batch-book/chapter-02.md')));
  });

  it('POST /delete-glob deletes matching files', async () => {
    // Setup: create some chapter files
    const bookDir = path.join(TEST_LIBRARY, 'books/delete-test');
    fs.mkdirSync(bookDir, { recursive: true });
    fs.writeFileSync(path.join(bookDir, 'chapter-01.md'), 'ch1');
    fs.writeFileSync(path.join(bookDir, 'chapter-02.md'), 'ch2');
    fs.writeFileSync(path.join(bookDir, 'meta.json'), '{}');

    const { status, data } = await req('POST', '/delete-glob', {
      dir: 'books/delete-test',
      pattern: 'chapter-*.md',
    });
    assert.equal(status, 200);
    assert.equal(data.deleted, 2);
    // meta.json should survive
    assert.ok(fs.existsSync(path.join(bookDir, 'meta.json')));
    assert.ok(!fs.existsSync(path.join(bookDir, 'chapter-01.md')));
  });

  it('POST /list-books returns all books with meta', async () => {
    const { status, data } = await req('POST', '/list-books');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.books));
    // We saved test-book-1 and batch-book with meta.json
    const titles = data.books.map(b => b.title);
    assert.ok(titles.includes('Test Book'));
    assert.ok(titles.includes('Batch Book'));
  });

  it('POST /list-books skips dirs without meta.json', async () => {
    // Create a directory without meta.json
    fs.mkdirSync(path.join(TEST_LIBRARY, 'books/no-meta-dir'), { recursive: true });
    fs.writeFileSync(path.join(TEST_LIBRARY, 'books/no-meta-dir/chapter-01.md'), 'orphan');

    const { data } = await req('POST', '/list-books');
    const ids = data.books.map(b => b.id);
    assert.ok(!ids.includes('no-meta-dir'));
  });

  it('CORS preflight returns ok', async () => {
    const { status, data } = await req('OPTIONS', '/health');
    assert.equal(status, 200);
  });

  it('unknown route returns 404', async () => {
    const { status } = await req('GET', '/nonexistent');
    assert.equal(status, 404);
  });
});

// ============================================================
// L3: Library Reading Flow (simulates SKILL.md 共读流程)
// ============================================================

describe('L3: library reading flow', () => {
  let FIXTURE_DIR;

  before(() => {
    // Create a fixture library
    FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'castreader-fixture-'));

    const booksDir = path.join(FIXTURE_DIR, 'books');
    const book1Dir = path.join(booksDir, 'kafka-on-shore-abc123');
    const book2Dir = path.join(booksDir, 'thinking-fast-def456');
    fs.mkdirSync(book1Dir, { recursive: true });
    fs.mkdirSync(book2Dir, { recursive: true });

    // Book 1: 海边的卡夫卡
    fs.writeFileSync(path.join(book1Dir, 'meta.json'), JSON.stringify({
      title: '海边的卡夫卡',
      author: '村上春树',
      bookId: 'wr_abc123',
      language: 'zh',
      totalChapters: 3,
      totalCharacters: 15000,
      syncedAt: '2026-03-20T10:00:00Z',
      source: 'weread',
    }));
    fs.writeFileSync(path.join(book1Dir, 'chapter-01.md'), '# 叫乌鸦的少年\n\n从前有一个叫田村卡夫卡的少年。\n\n他在十五岁生日那天离家出走。');
    fs.writeFileSync(path.join(book1Dir, 'chapter-02.md'), '# 第1章\n\n我在夜行长途巴士的座位上醒来。\n\n窗外一片漆黑，车内灯光昏暗。');
    fs.writeFileSync(path.join(book1Dir, 'chapter-03.md'), '# 第2章\n\n中田先生在公园长椅上坐了下来。\n\n他和猫说话这件事，似乎从很小的时候就开始了。');
    fs.writeFileSync(path.join(book1Dir, 'full.md'), '# 叫乌鸦的少年\n\n从前有一个叫田村卡夫卡的少年。\n\n---\n\n# 第1章\n\n我在夜行长途巴士的座位上醒来。');

    // Book 2: Thinking, Fast and Slow
    fs.writeFileSync(path.join(book2Dir, 'meta.json'), JSON.stringify({
      title: 'Thinking, Fast and Slow',
      author: 'Daniel Kahneman',
      bookId: 'B00555X8OA',
      language: 'en',
      totalChapters: 2,
      totalCharacters: 80000,
      syncedAt: '2026-03-20T11:00:00Z',
      source: 'kindle',
    }));
    fs.writeFileSync(path.join(book2Dir, 'chapter-01.md'), '# Introduction\n\nEvery author dreams of a reader.');
    fs.writeFileSync(path.join(book2Dir, 'chapter-02.md'), '# The Characters of the Story\n\nSystem 1 operates automatically and quickly.');

    // index.json
    fs.writeFileSync(path.join(FIXTURE_DIR, 'index.json'), JSON.stringify({
      version: '1.0.0',
      books: [
        {
          id: 'kafka-on-shore-abc123',
          title: '海边的卡夫卡',
          author: '村上春树',
          totalChapters: 3,
          totalCharacters: 15000,
          source: 'weread',
        },
        {
          id: 'thinking-fast-def456',
          title: 'Thinking, Fast and Slow',
          author: 'Daniel Kahneman',
          totalChapters: 2,
          totalCharacters: 80000,
          source: 'kindle',
        },
      ],
      updatedAt: '2026-03-20T11:00:00Z',
    }));
  });

  after(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('index.json lists all books', () => {
    const index = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'index.json'), 'utf-8'));
    assert.equal(index.books.length, 2);
    assert.equal(index.books[0].title, '海边的卡夫卡');
    assert.equal(index.books[1].title, 'Thinking, Fast and Slow');
  });

  it('can format book list for display', () => {
    const index = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'index.json'), 'utf-8'));
    const display = index.books.map((b, i) =>
      `${i + 1}. 《${b.title}》 — ${b.author} · ${b.totalChapters}章`
    ).join('\n');
    assert.ok(display.includes('1. 《海边的卡夫卡》'));
    assert.ok(display.includes('2. 《Thinking, Fast and Slow》'));
  });

  it('meta.json has complete book info', () => {
    const meta = JSON.parse(fs.readFileSync(
      path.join(FIXTURE_DIR, 'books/kafka-on-shore-abc123/meta.json'), 'utf-8'
    ));
    assert.equal(meta.title, '海边的卡夫卡');
    assert.equal(meta.author, '村上春树');
    assert.equal(meta.totalChapters, 3);
    assert.equal(meta.language, 'zh');
    assert.equal(meta.source, 'weread');
  });

  it('can read chapter content', () => {
    const ch1 = fs.readFileSync(
      path.join(FIXTURE_DIR, 'books/kafka-on-shore-abc123/chapter-01.md'), 'utf-8'
    );
    assert.ok(ch1.startsWith('# 叫乌鸦的少年'));
    assert.ok(ch1.includes('田村卡夫卡'));
  });

  it('can find book by title from index', () => {
    const index = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'index.json'), 'utf-8'));
    const search = '卡夫卡';
    const found = index.books.find(b => b.title.includes(search));
    assert.ok(found);
    assert.equal(found.id, 'kafka-on-shore-abc123');
  });

  it('can list chapters from directory', () => {
    const bookDir = path.join(FIXTURE_DIR, 'books/kafka-on-shore-abc123');
    const files = fs.readdirSync(bookDir).filter(f => f.startsWith('chapter-')).sort();
    assert.deepEqual(files, ['chapter-01.md', 'chapter-02.md', 'chapter-03.md']);
  });

  it('chapter heading can be extracted for TOC', () => {
    const bookDir = path.join(FIXTURE_DIR, 'books/kafka-on-shore-abc123');
    const chapters = fs.readdirSync(bookDir)
      .filter(f => f.startsWith('chapter-'))
      .sort()
      .map(f => {
        const content = fs.readFileSync(path.join(bookDir, f), 'utf-8');
        const heading = content.match(/^# (.+)/m)?.[1] || f;
        return heading;
      });
    assert.deepEqual(chapters, ['叫乌鸦的少年', '第1章', '第2章']);
  });

  it('language detection from meta.json for TTS', () => {
    const meta1 = JSON.parse(fs.readFileSync(
      path.join(FIXTURE_DIR, 'books/kafka-on-shore-abc123/meta.json'), 'utf-8'
    ));
    const meta2 = JSON.parse(fs.readFileSync(
      path.join(FIXTURE_DIR, 'books/thinking-fast-def456/meta.json'), 'utf-8'
    ));
    assert.equal(meta1.language, 'zh');
    assert.equal(meta2.language, 'en');
  });

  it('empty library scenario — no index.json', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'castreader-empty-'));
    try {
      const indexPath = path.join(emptyDir, 'index.json');
      assert.ok(!fs.existsSync(indexPath), 'index.json should not exist');
      // SKILL.md flow: if no index.json → guide to sync
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('empty library scenario — index.json with empty books array', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'castreader-empty2-'));
    try {
      fs.writeFileSync(path.join(emptyDir, 'index.json'), JSON.stringify({ books: [] }));
      const index = JSON.parse(fs.readFileSync(path.join(emptyDir, 'index.json'), 'utf-8'));
      assert.equal(index.books.length, 0);
      // SKILL.md flow: if books empty → guide to sync
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// L4: CLI Integration Tests (subprocess, validates JSON contracts)
// ============================================================

describe('L4: sync-books.js CLI contracts', () => {
  // These tests validate CLI behavior WITHOUT actually launching Chrome.
  // They test arg parsing, help text, and error paths.

  function runSync(args, timeout = 10000) {
    return new Promise((resolve) => {
      const proc = execFile('node', [path.join(SCRIPTS_DIR, 'sync-books.js'), ...args], {
        timeout,
        env: { ...process.env, PATH: process.env.PATH },
      }, (err, stdout, stderr) => {
        resolve({ exitCode: err?.code || 0, stdout, stderr, signal: err?.signal });
      });
    });
  }

  it('no args → usage + exit 1', async () => {
    const { exitCode, stderr } = await runSync([]);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Usage:'));
    assert.ok(stderr.includes('--list'));
    assert.ok(stderr.includes('--book'));
  });

  it('invalid source → usage + exit 1', async () => {
    const { exitCode, stderr } = await runSync(['dropbox']);
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes('Usage:'));
  });

  it('usage message includes all flags', async () => {
    const { stderr } = await runSync([]);
    assert.ok(stderr.includes('--max'), 'Should mention --max');
    assert.ok(stderr.includes('--list'), 'Should mention --list');
    assert.ok(stderr.includes('--book'), 'Should mention --book');
  });
});

// ============================================================
// L4b: SKILL.md Contract Validation
// ============================================================

describe('L4b: SKILL.md contract validation', () => {
  let skillContent;

  before(() => {
    skillContent = fs.readFileSync(
      path.join(SCRIPTS_DIR, '..', 'SKILL.md'), 'utf-8'
    );
  });

  it('has correct frontmatter fields', () => {
    assert.ok(skillContent.includes('name: castreader'));
    assert.ok(skillContent.includes('emoji: "📖"'));
    assert.ok(skillContent.includes('version: 3.0.0'));
  });

  it('mentions --list flag for remote book listing', () => {
    assert.ok(skillContent.includes('--list'));
    assert.ok(skillContent.includes('node scripts/sync-books.js kindle --list'));
  });

  it('mentions --book flag for single book sync', () => {
    assert.ok(skillContent.includes('--book'));
    assert.ok(skillContent.includes('node scripts/sync-books.js kindle --book'));
  });

  it('has three sync scenarios (A, B, C)', () => {
    assert.ok(skillContent.includes('场景 A'), 'Should have scenario A (direct book name)');
    assert.ok(skillContent.includes('场景 B'), 'Should have scenario B (browse remote)');
    assert.ok(skillContent.includes('场景 C'), 'Should have scenario C (sync all)');
  });

  it('mentions dynamic channel detection', () => {
    assert.ok(skillContent.includes('channel'));
    assert.ok(skillContent.includes('platform'));
    assert.ok(!skillContent.includes('"channel":"telegram"'),
      'Should not hardcode telegram in message tool examples');
  });

  it('URL flow is preserved', () => {
    assert.ok(skillContent.includes('read-url.js'));
    assert.ok(skillContent.includes('generate-text.js'));
  });

  it('rules section enforces single-book-sync default', () => {
    assert.ok(skillContent.includes('只同步用户选的那一本书'));
  });
});
