# CastReader — Read & Listen to Books with AI | OpenClaw Skill

[![OpenClaw Skill](https://img.shields.io/badge/OpenClaw-Skill-blue)](https://clawhub.com/castreader)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)]()

**Pick a book from your Kindle or WeRead library. Read chapter by chapter with AI, discuss, and listen aloud.**

Works on Telegram, WhatsApp, WeChat, and iMessage — anywhere OpenClaw runs.

## Why CastReader?

Your books are locked inside Kindle and WeRead. You can't export them, search across them, or discuss them with AI — unless you manually copy-paste chapters into ChatGPT.

CastReader solves this. It syncs your books as clean markdown, then lets you read together with AI:

```
You:  我想看活着
Bot:  找到以下结果：
      1. 活着 - 余华 (92.0%)
      2. 活着：清影纪录中国2011
      你想看哪一本？

You:  第一个
Bot:  正在同步《活着》，约1-2分钟...
      ✅ 同步完成！共12章。
      📖 目录：
      1. 有庆  2. 家珍  3. 凤霞 ...
      从哪一章开始？

You:  第一章
Bot:  [读章节、讨论、回答问题]

You:  念给我听
Bot:  🔊 [生成 MP3 发到手机]

You:  下一章
Bot:  [继续共读]
```

### CastReader vs. "Just upload an EPUB to ChatGPT"

| | CastReader | Upload EPUB manually |
|---|---|---|
| **Get the book** | Pick one, sync just that book | Find DRM-free EPUB, convert, upload |
| **Kindle books** | Pick and sync on demand | Can't export from Kindle |
| **WeRead books** | Pick and sync on demand | Can't export from WeRead |
| **Reading flow** | Chapter-by-chapter with AI discussion | Dump entire book, lose structure |
| **Listen aloud** | Natural TTS, sent as MP3 | Not available |
| **Multiple books** | Persistent library, switch anytime | Re-upload each time |
| **Search** | Instant grep across all chapters | Not available |

## How It Works

1. **Pick** — Tell the AI which book you want to read. It checks your local library first, then searches WeRead online if not found
2. **Sync** — Only the book you picked gets synced as clean markdown — no bulk downloads
3. **Read** — Go chapter by chapter. AI summarizes, discusses, answers questions
4. **Listen** — Say "read it aloud" and get an MP3 sent to your phone
5. **Search** — Ask "which chapter mentions X?" and get instant results across the entire book

## Architecture

```
┌──────────────────────────────────────────────┐
│  search-book.js  (all-in-one, no browser)    │
│  --find: local fuzzy match + online fallback │
│  --online: WeRead HTML search API            │
│  --shelf / --summary / --read / --grep       │
├──────────────────────────────────────────────┤
│  sync-books.js   (Puppeteer, browser needed) │
│  --list: scan Kindle/WeRead library          │
│  --book: sync single book to markdown        │
│  --search: WeRead search (legacy, slower)    │
│  --add-shelf: add book to WeRead shelf       │
├──────────────────────────────────────────────┤
│  generate-text.js  (TTS API)                 │
│  Text → MP3 via CastReader TTS API           │
├──────────────────────────────────────────────┤
│  ~/castreader-library/                       │
│  └── books/{title}-{bookId}/                 │
│      ├── meta.json                           │
│      ├── chapter-01.md ... chapter-NN.md     │
│      └── full.md                             │
└──────────────────────────────────────────────┘
```

### Performance (tested 2026-03-24)

| Operation | Time | Method |
|-----------|------|--------|
| Local book lookup | ~100ms | File system + fuzzy match |
| Online search (WeRead) | ~650ms | Direct HTTPS to search page |
| Read chapter | ~80ms | File read |
| Batch read 10 chapters | ~98ms | File read |
| Grep entire book | ~90ms | In-memory search |
| Shelf list | ~100ms | JSON read |
| TTS generation | ~60s | API call |
| Book sync (WeRead, 20ch) | ~2min | Puppeteer + MutationObserver |
| Book sync (Kindle, 50ch) | ~8min | Puppeteer + OCR |

### Fuzzy Matching (tested 22 queries, 95% hit rate)

The local search accepts partial names, titles, and author names:
- "悉达多" → "悉达多（知书经典）"
- "地下室" → "地下室手记：陀思妥耶夫斯基中短篇小说集..."
- "hold on" → "Hold On To Me: Love Rekindled..."
- "刘慈欣" → "三体前传：球状闪电 弦" (author match)
- "荔枝" → "长安的荔枝（同名影视原著）"

## Installation

```bash
clawhub install castreader
```

**Requirements:** Node.js 18+

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CASTREADER_VOICE` | `af_heart` | TTS voice selection |
| `CASTREADER_SPEED` | `1.5` | Playback speed |
| `CASTREADER_API_URL` | `http://api.castreader.ai:8123` | API endpoint |

## Links

- **Website:** [castreader.ai](https://castreader.ai)
- **OpenClaw page:** [castreader.ai/openclaw](https://castreader.ai/openclaw)
- **Chrome Web Store:** [CastReader Extension](https://chromewebstore.google.com/detail/castreader-tts-reader/foammmkhpbeladledijkdljlechlclpb)
- **Edge Add-ons:** [CastReader for Edge](https://microsoftedge.microsoft.com/addons/detail/niidajfbelfcgnkmnpcmdlioclhljaaj)
- **ClawHub:** [clawhub.com/castreader](https://clawhub.com/castreader)

## License

MIT
