#!/usr/bin/env node
/**
 * search-book.js — Search book content locally (no browser needed)
 *
 * Usage:
 *   node scripts/search-book.js <bookId> --grep "keyword"     # Search all chapters for keyword
 *   node scripts/search-book.js <bookId> --chapters            # List all chapters with char counts
 *   node scripts/search-book.js <bookId> --read 5              # Read chapter 5
 *   node scripts/search-book.js <bookId> --read 5-8            # Read chapters 5 through 8
 *   node scripts/search-book.js <bookId> --read all            # Read entire book (full.md)
 *   node scripts/search-book.js <bookId> --summary             # Book overview: meta + chapter list
 *
 * All output is JSON to stdout. Instant — no network, no browser.
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
    // Try fuzzy match: exact substring first, then partial match
    const booksDir = path.join(LIBRARY_PATH, 'books');
    if (fs.existsSync(booksDir)) {
      const dirs = fs.readdirSync(booksDir);
      // Exact substring match (bookId appears in dir name, or dir name appears in bookId)
      const matches = dirs.filter(d => d.includes(bookId) || bookId.includes(d));
      if (matches.length === 1) {
        // Single match — auto-resolve
        bookDir = path.join(booksDir, matches[0]);
        process.stderr.write(`Resolved "${bookId}" → "${matches[0]}"\n`);
      } else if (matches.length > 1) {
        // Multiple matches — pick best (shortest name = closest match)
        matches.sort((a, b) => a.length - b.length);
        bookDir = path.join(booksDir, matches[0]);
        process.stderr.write(`Resolved "${bookId}" → "${matches[0]}" (${matches.length} candidates)\n`);
      } else {
        console.error(`Book "${bookId}" not found. Available books:`);
        dirs.forEach(d => console.error(`  - ${d}`));
        process.exit(1);
      }
    } else {
      console.error(`Library not found at ${booksDir}`);
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

main();
