#!/usr/bin/env node
/**
 * search-book.js — Search book content locally + online (no browser needed)
 *
 * Usage:
 *   node scripts/search-book.js <bookId> --grep "keyword"     # Search all chapters for keyword
 *   node scripts/search-book.js <bookId> --chapters            # List all chapters with char counts
 *   node scripts/search-book.js <bookId> --read 5              # Read chapter 5
 *   node scripts/search-book.js <bookId> --read 5-8            # Read chapters 5 through 8
 *   node scripts/search-book.js <bookId> --read all            # Read entire book (full.md)
 *   node scripts/search-book.js <bookId> --summary             # Book overview: meta + chapter list
 *   node scripts/search-book.js --online "keyword"             # Search WeRead online (no Puppeteer, <1s)
 *   node scripts/search-book.js --find "keyword"               # Local first, online fallback (best for skill)
 *   node scripts/search-book.js --shelf                        # List all local books
 *
 * All output is JSON to stdout. Local ops are instant. Online search <1s (direct API).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LIBRARY_PATH = path.join(os.homedir(), 'castreader-library');

function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: node scripts/search-book.js <bookId> --grep "keyword"');
    console.error('       node scripts/search-book.js <bookId> --chapters');
    console.error('       node scripts/search-book.js <bookId> --read <N|N-M|all>');
    console.error('       node scripts/search-book.js <bookId> --summary');
    process.exit(1);
  }

  const bookId = args[0];
  let bookDir = path.join(LIBRARY_PATH, 'books', bookId);

  if (!fs.existsSync(bookDir)) {
    const booksDir = path.join(LIBRARY_PATH, 'books');
    if (!fs.existsSync(booksDir)) {
      console.error(`Library not found at ${booksDir}`);
      process.exit(1);
    }
    const dirs = fs.readdirSync(booksDir);
    // Also load meta.json titles for better matching
    const dirsWithMeta = dirs.map(d => {
      let title = '';
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(booksDir, d, 'meta.json'), 'utf-8'));
        title = meta.title || '';
      } catch {}
      return { dir: d, title };
    });

    // Normalize query: lowercase, spaces→hyphens for dir matching
    const q = bookId.toLowerCase();
    const qDash = q.replace(/\s+/g, '-');

    // Score each book: higher = better match
    function score(entry) {
      const d = entry.dir.toLowerCase();
      const t = entry.title.toLowerCase();
      const a = entry.author.toLowerCase();
      // Exact dir name match
      if (d === q || d === qDash) return 100;
      // Title exact match
      if (t === q) return 90;
      // Title starts with query
      if (t.startsWith(q)) return 80;
      // Dir starts with query (before first -)
      const dirName = d.split('-')[0];
      if (dirName === q || dirName === qDash) return 75;
      // Query is substring of title
      if (t.includes(q)) return 70;
      // Author match
      if (a.includes(q)) return 65;
      // Query is substring of dir
      if (d.includes(q) || d.includes(qDash)) return 60;
      // Title is substring of query
      if (q.includes(t) && t.length > 1) return 50;
      // Dir name (first segment) is substring of query
      if (q.includes(dirName) && dirName.length > 1) return 40;
      return 0;
    }

    const scored = dirsWithMeta.map(e => ({ ...e, score: score(e) }))
      .filter(e => e.score > 0)
      .sort((a, b) => b.score - a.score || a.dir.length - b.dir.length);

    if (scored.length > 0) {
      bookDir = path.join(booksDir, scored[0].dir);
      const label = scored[0].title || scored[0].dir;
      process.stderr.write(`Resolved "${bookId}" → "${label}"\n`);
    } else {
      console.error(`Book "${bookId}" not found. Available books:`);
      dirsWithMeta.forEach(e => console.error(`  - ${e.title || e.dir}`));
      process.exit(1);
    }
  }

  // Load meta
  const metaPath = path.join(bookDir, 'meta.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf-8')) : {};

  // Get sorted chapter files
  const chapterFiles = fs.readdirSync(bookDir)
    .filter(f => /^chapter-\d+\.md$/.test(f))
    .sort((a, b) => {
      const na = parseInt(a.match(/\d+/)[0]);
      const nb = parseInt(b.match(/\d+/)[0]);
      return na - nb;
    });

  // Parse command
  if (args.includes('--grep')) {
    const grepIdx = args.indexOf('--grep');
    const keyword = args[grepIdx + 1];
    if (!keyword) { console.error('Missing keyword for --grep'); process.exit(1); }
    doGrep(bookDir, chapterFiles, meta, keyword);
  } else if (args.includes('--chapters')) {
    doChapters(bookDir, chapterFiles, meta);
  } else if (args.includes('--read')) {
    const readIdx = args.indexOf('--read');
    const range = args[readIdx + 1];
    if (!range) { console.error('Missing range for --read'); process.exit(1); }
    doRead(bookDir, chapterFiles, meta, range);
  } else if (args.includes('--summary')) {
    doSummary(bookDir, chapterFiles, meta);
  } else {
    console.error('Unknown command. Use --grep, --chapters, --read, or --summary');
    process.exit(1);
  }
}

function doGrep(bookDir, chapterFiles, meta, keyword) {
  const results = [];
  const kwLower = keyword.toLowerCase();

  for (const file of chapterFiles) {
    const chapterNum = parseInt(file.match(/\d+/)[0]);
    const content = fs.readFileSync(path.join(bookDir, file), 'utf-8');
    const lines = content.split('\n');

    // Get chapter title from first line
    const title = lines[0]?.replace(/^#+\s*/, '').trim() || `Chapter ${chapterNum}`;

    // Find matching lines with context
    const matches = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(kwLower)) {
        // Get surrounding context (1 line before, 1 after)
        const ctxStart = Math.max(0, i - 1);
        const ctxEnd = Math.min(lines.length - 1, i + 1);
        const context = lines.slice(ctxStart, ctxEnd + 1).join('\n').trim();
        matches.push({ line: i + 1, context: context.substring(0, 300) });
      }
    }

    if (matches.length > 0) {
      results.push({
        chapter: chapterNum,
        title,
        file,
        matchCount: matches.length,
        matches: matches.slice(0, 5), // Limit to 5 matches per chapter
      });
    }
  }

  console.log(JSON.stringify({
    event: 'grep_results',
    book: meta.title || 'Unknown',
    keyword,
    totalMatches: results.reduce((s, r) => s + r.matchCount, 0),
    chaptersWithMatches: results.length,
    results,
  }, null, 2));
}

function doChapters(bookDir, chapterFiles, meta) {
  const chapters = chapterFiles.map(file => {
    const num = parseInt(file.match(/\d+/)[0]);
    const content = fs.readFileSync(path.join(bookDir, file), 'utf-8');
    const title = content.split('\n')[0]?.replace(/^#+\s*/, '').trim() || `Chapter ${num}`;
    return { chapter: num, title, chars: content.length, file };
  });

  console.log(JSON.stringify({
    event: 'chapters',
    book: meta.title || 'Unknown',
    author: meta.author || 'Unknown',
    totalChapters: chapters.length,
    totalChars: chapters.reduce((s, c) => s + c.chars, 0),
    chapters,
  }, null, 2));
}

function doRead(bookDir, chapterFiles, meta, range) {
  if (range === 'all') {
    // Try full.md first
    const fullPath = path.join(bookDir, 'full.md');
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      console.log(JSON.stringify({
        event: 'read',
        book: meta.title || 'Unknown',
        range: 'all',
        chars: content.length,
        content,
      }));
    } else {
      // Concatenate all chapters
      let content = '';
      for (const file of chapterFiles) {
        content += fs.readFileSync(path.join(bookDir, file), 'utf-8') + '\n\n---\n\n';
      }
      console.log(JSON.stringify({
        event: 'read',
        book: meta.title || 'Unknown',
        range: 'all',
        chapters: chapterFiles.length,
        chars: content.length,
        content,
      }));
    }
    return;
  }

  // Parse range: "5" or "5-8"
  let start, end;
  if (range.includes('-')) {
    const parts = range.split('-');
    start = parseInt(parts[0]);
    end = parseInt(parts[1]);
  } else {
    start = parseInt(range);
    end = start;
  }

  const contents = [];
  for (let i = start; i <= end; i++) {
    const padded = String(i).padStart(2, '0');
    const file = `chapter-${padded}.md`;
    const filePath = path.join(bookDir, file);
    if (fs.existsSync(filePath)) {
      contents.push({
        chapter: i,
        content: fs.readFileSync(filePath, 'utf-8'),
      });
    }
  }

  if (contents.length === 0) {
    console.error(`No chapters found in range ${range}`);
    process.exit(1);
  }

  const merged = contents.map(c => c.content).join('\n\n---\n\n');
  console.log(JSON.stringify({
    event: 'read',
    book: meta.title || 'Unknown',
    range,
    chapters: contents.length,
    chars: merged.length,
    content: merged,
  }));
}

function doSummary(bookDir, chapterFiles, meta) {
  const chapters = chapterFiles.map(file => {
    const num = parseInt(file.match(/\d+/)[0]);
    const content = fs.readFileSync(path.join(bookDir, file), 'utf-8');
    const title = content.split('\n')[0]?.replace(/^#+\s*/, '').trim() || `Chapter ${num}`;
    return { chapter: num, title, chars: content.length };
  });

  console.log(JSON.stringify({
    event: 'summary',
    title: meta.title || 'Unknown',
    author: meta.author || 'Unknown',
    source: meta.source || 'unknown',
    language: meta.language || 'unknown',
    totalChapters: chapters.length,
    totalChars: chapters.reduce((s, c) => s + c.chars, 0),
    syncedAt: meta.syncedAt || 'unknown',
    chapters,
  }, null, 2));
}

// ---- Online Search (WeRead API, no Puppeteer) ----

async function doOnlineSearch(keyword) {
  const https = require('https');
  // Use the HTML search page — it contains readerBookId (needed for --add-shelf and sync)
  const parsedUrl = new URL(`https://weread.qq.com/web/search/books?keyword=${encodeURIComponent(keyword)}`);
  const opts = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
  };

  return new Promise((resolve, reject) => {
    https.get(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        // Parse SSR-rendered book list: split by <li class="wr_bookList_item">
        const books = [];
        const items = data.split('<li class="wr_bookList_item">');
        for (let i = 1; i < items.length && books.length < 10; i++) {
          const chunk = items[i];
          const hrefMatch = chunk.match(/href="\/web\/(?:reader|bookDetail)\/([^"]+)"/);
          if (!hrefMatch) continue;
          const readerBookId = hrefMatch[1].trim();

          const titleMatch = chunk.match(/wr_bookList_item_title"[^>]*>([\s\S]*?)<\/p>/);
          const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

          const authorMatch = chunk.match(/wr_bookList_item_author"[^>]*>([\s\S]*?)<\/p>/);
          const author = authorMatch ? authorMatch[1].replace(/<[^>]+>/g, '').trim() : '';

          const descMatch = chunk.match(/wr_bookList_item_desc"[^>]*>([\s\S]*?)<\/p>/);
          const intro = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim().substring(0, 200) : '';

          const ratingMatch = chunk.match(/wr_bookList_item_reading_percent"[^>]*>([\s\S]*?)<\/span>/);
          const rating = ratingMatch ? ratingMatch[1].trim() : '';

          if (title) {
            books.push({ title, author, readerBookId, intro, rating,
              readerUrl: `https://weread.qq.com/web/reader/${readerBookId}` });
          }
        }

        console.log(JSON.stringify({
          event: 'search_results',
          keyword,
          totalCount: books.length,
          books,
        }, null, 2));
        resolve();
      });
    }).on('error', (e) => {
      console.error(`Search request failed: ${e.message}`);
      process.exit(1);
    });
  });
}

// ---- Find: local first, online fallback ----

async function doFind(keyword) {
  // Try local fuzzy match first
  const booksDir = path.join(LIBRARY_PATH, 'books');
  if (fs.existsSync(booksDir)) {
    const dirs = fs.readdirSync(booksDir);
    const dirsWithMeta = dirs.map(d => {
      let title = '', author = '', meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(path.join(booksDir, d, 'meta.json'), 'utf-8'));
        title = meta.title || '';
        author = meta.author || '';
      } catch {}
      return { dir: d, title, author, meta };
    });

    const q = keyword.toLowerCase();
    const matches = dirsWithMeta.filter(e => {
      const t = e.title.toLowerCase();
      const d = e.dir.toLowerCase();
      const a = e.author.toLowerCase();
      return t.includes(q) || d.includes(q) || a.includes(q) || q.includes(t);
    });

    if (matches.length > 0) {
      // Best local match — return summary
      const best = matches[0];
      const bookDir = path.join(booksDir, best.dir);
      const chapterFiles = fs.readdirSync(bookDir)
        .filter(f => /^chapter-\d+\.md$/.test(f))
        .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

      const chapters = chapterFiles.map(file => {
        const num = parseInt(file.match(/\d+/)[0]);
        const content = fs.readFileSync(path.join(bookDir, file), 'utf-8');
        const title = content.split('\n')[0]?.replace(/^#+\s*/, '').trim() || `Chapter ${num}`;
        return { chapter: num, title, chars: content.length };
      });

      console.log(JSON.stringify({
        event: 'local_hit',
        bookDir: best.dir,
        title: best.meta.title || best.dir,
        author: best.meta.author || 'Unknown',
        source: best.meta.source || 'unknown',
        language: best.meta.language || 'unknown',
        totalChapters: chapters.length,
        totalChars: chapters.reduce((s, c) => s + c.chars, 0),
        syncedAt: best.meta.syncedAt || 'unknown',
        chapters,
      }, null, 2));
      return;
    }
  }

  // No local match — search online
  process.stderr.write(`Not found locally, searching WeRead...\n`);
  await doOnlineSearch(keyword);
}

// ---- Shelf: list all local books ----

function doShelf() {
  const indexPath = path.join(LIBRARY_PATH, 'index.json');
  if (!fs.existsSync(indexPath)) {
    console.log(JSON.stringify({ event: 'shelf', books: [] }));
    return;
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  const books = (index.books || []).map(b => ({
    title: b.title || '',
    author: b.author || '',
    source: b.source || '',
    dirName: b.dirName || '',
    totalChapters: b.totalChapters || 0,
    totalCharacters: b.totalCharacters || 0,
  }));
  console.log(JSON.stringify({ event: 'shelf', totalBooks: books.length, books }, null, 2));
}

// ---- Main ----

const args = process.argv.slice(2);

if (args.includes('--online')) {
  const idx = args.indexOf('--online');
  const kw = args[idx + 1];
  if (!kw) { console.error('Usage: --online "keyword"'); process.exit(1); }
  doOnlineSearch(kw).catch(e => { console.error(e); process.exit(1); });
} else if (args.includes('--find')) {
  const idx = args.indexOf('--find');
  const kw = args[idx + 1];
  if (!kw) { console.error('Usage: --find "keyword"'); process.exit(1); }
  doFind(kw).catch(e => { console.error(e); process.exit(1); });
} else if (args.includes('--shelf')) {
  doShelf();
} else {
  main();
}
