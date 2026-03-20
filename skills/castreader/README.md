# CastReader — Read & Listen to Books with AI | OpenClaw Skill

[![OpenClaw Skill](https://img.shields.io/badge/OpenClaw-Skill-blue)](https://clawhub.com/castreader)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey)]()

**Pick a book from your Kindle or WeRead library. Read chapter by chapter with AI, discuss, and listen aloud.**

Works on Telegram, WhatsApp, and iMessage — anywhere OpenClaw runs.

## Why CastReader?

Your books are locked inside Kindle and WeRead. You can't export them, search across them, or discuss them with AI — unless you manually copy-paste chapters into ChatGPT.

CastReader solves this. It syncs your books as clean markdown, then lets you read together with AI:

```
You:  I want to read a book
Bot:  Kindle or WeRead? Let me check your library.
      📚 Your Kindle books (12 books):
      1. 《海边的卡夫卡》 — 村上春树
      2. 《Thinking, Fast and Slow》 — Kahneman
      ...
      Which one?

You:  Kafka on the Shore
Bot:  Syncing "海边的卡夫卡"... Done! 58 chapters.
      📖 Table of contents:
      1. 版权信息  2. 中文版序言  3. 译序  4. 叫乌鸦的少年  5. 第1章 ...
      Where to start?

You:  Chapter 5
Bot:  [reads chapter, gives overview, starts discussion]

You:  Read it aloud
Bot:  🔊 [sends MP3 to your phone]

You:  Next chapter
Bot:  [continues reading together]
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

## How It Works

1. **Pick** — Tell the AI which book you want to read. It lists your Kindle/WeRead library and you choose one
2. **Sync** — Only the book you picked gets synced as clean markdown — no bulk downloads
3. **Read** — Go chapter by chapter. AI summarizes, discusses, answers questions
4. **Listen** — Say "read it aloud" and get an MP3 sent to your phone

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
