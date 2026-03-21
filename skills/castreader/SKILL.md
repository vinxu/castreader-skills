---
name: castreader
description: >
  Read books together with AI. Pick a book from your Kindle or WeRead library,
  discuss chapter by chapter, and listen aloud.
version: 3.1.3
metadata:
  openclaw:
    emoji: "📖"
    requires:
      anyBins: ["node"]
    os: ["darwin", "linux", "win32"]
    homepage: https://castreader.ai/openclaw
---

# CastReader — Read & Listen to Books with AI

## Setup (once per session)

```
cd <skill-directory> && npm install --silent 2>/dev/null
```

## Platform & User Detection

User message prefix format: `[<Platform> <username> id:<chatId> ...]`
- Platform = Telegram / WhatsApp / iMessage
- chatId = target for the message tool
- channel = platform.toLowerCase()

Examples:
- `[Telegram xu id:123]` → channel="telegram", target="123"
- `[WhatsApp John id:456]` → channel="whatsapp", target="456"

---

## CRITICAL UX RULES

**Users are on their phone. They cannot see what's happening on the server.**

### Rule 1: Explain WHY before doing anything

Users need to understand the reason behind each step. Don't just say "logging in" — explain WHY login is needed.

- "Your books are stored in Kindle's cloud. To access your bookshelf, I need to connect to your Kindle account first."
- "I'm downloading the book page by page from Kindle Cloud Reader — this takes a few minutes because each page needs to be processed."
- "I need to convert this chapter to audio. This takes about 1 minute..."

### Rule 2: Tell WHAT + HOW LONG before starting

Every operation MUST be announced before running:
- Listing books: "~30 seconds"
- Syncing a short book (<20 chapters): "1-3 minutes"
- Syncing a long book (>50 chapters): "5-10 minutes"
- Generating audio: "~1 minute"

### Rule 3: Send progress during long operations

Anything longer than 30 seconds needs periodic updates.

### Rule 4: Confirm completion + show next step immediately

**Example of GOOD communication:**
```
Your books are stored in Kindle's cloud — I need to download this one to read it together with you.
Syncing "A Journey to the Centre of the Earth" now. This usually takes 2-3 minutes...

📖 Syncing... 25% done
📖 Syncing... 60% done
✅ Done! 43 chapters synced. Here's the table of contents:
```

**Example of BAD communication (NEVER do this):**
```
[runs sync command silently for 5 minutes with no message to user]
```

---

## Core Flow: Read Together

### Entry Point

1. Check local library at `~/castreader-library/index.json`
   - Has synced books → Show book list, let user pick
   - Empty or missing → Guide to sync
2. User wants a new book not in library → Sync that one book

### Show Local Book List

```
cat ~/castreader-library/index.json 2>/dev/null || echo '{"books":[]}'
```

Format as numbered list, then ask which one to read.

### After User Picks a Book → Show Table of Contents

```
cat ~/castreader-library/books/<id>/meta.json
```

List chapters, ask where to start.

### After User Picks a Chapter → Read Together

```
cat ~/castreader-library/books/<id>/chapter-NN.md
```

- Give chapter overview / discussion points
- Free conversation: discuss, questions, summary
- User says "next chapter" → continue

### Read Aloud (user says "read it aloud" / "listen")

**Tell user first:** "Generating audio for this chapter, about 1 minute..."

1. Save chapter to temp file
2. Generate: `node scripts/generate-text.js /tmp/castreader-chapter.txt <language>`
3. Send MP3 via message tool

---

## Sync Books (library empty or user wants new book)

### Step 1: Ask platform

Ask: "Do you use **Kindle** or **WeRead**?"

### Step 2: List books

**IMPORTANT: Do NOT use sync-login.js. Do NOT take screenshots. Do NOT poll login status.**

The `sync-books.js --list` script handles EVERYTHING automatically:
- Opens browser with saved login session
- If already logged in → lists books immediately
- If not logged in → opens login page, waits for user to log in, then lists books

Just tell the user and run:

**Tell user:** "正在扫描你的书架，大约 30 秒..."

```
node scripts/sync-books.js <kindle|weread> --list
```

**Handle output (stdout may contain multiple JSON lines — process each):**

- `{"books":[...]}` → Show numbered list, ask which one to read
- `{"event":"login_complete"}` → Login was automatic or cookie-restored, no user action needed
- `{"event":"wechat_qr","screenshot":"/path/to/qr.png"}` → **Send the QR image to user via message tool**, then tell user: "请用微信扫描这个二维码登录微信读书，登录后会自动开始同步"
- `{"event":"login_required","source":"kindle"}` → **Ask user**: "需要登录 Kindle，你可以选择：\n1. 自己去电脑浏览器上登录\n2. 把亚马逊邮箱和密码发给我，我帮你自动登录"
  - If user provides email and password → Kill the current script, re-run with credentials:
    `node scripts/sync-books.js kindle --list --email "user@email.com" --password "password123"`
  - If user says they'll log in themselves → Wait for the current script to detect login completion
- `{"event":"kindle_2fa_required","screenshot":"/path/to/screenshot.png"}` → **Send the screenshot to user via message tool**, then tell user: "亚马逊需要验证码，请查看手机短信或邮箱，把验证码发给我"
- `{"event":"kindle_login_error","message":"..."}` → Tell user the error message, ask them to retry
- stderr "Already logged in" → Login was automatic, no user action needed
- Script exits with error → Tell user and retry

**IMPORTANT for WeRead QR:** The script outputs a JSON line with `event: "wechat_qr"` and `screenshot` path. You MUST read that image file and send it to the user via the message tool so they can scan it on their phone. Do NOT just tell them to look at the computer screen.

**IMPORTANT for Kindle credentials:** When user provides email/password, pass them via `--email` and `--password` flags. The script will auto-fill the Amazon login form. If 2FA is required, send the screenshot to the user and wait for them to provide the code. **NEVER store or log the user's password.**

**STOP and wait for user to pick a book.**

### Step 3: Sync the selected book

**Tell user first:** "正在同步《书名》，大约需要 1-2 分钟..."

```
node scripts/sync-books.js <kindle|weread> --book "Book Title"
```

After sync complete → Show table of contents, ask where to start reading.

**If sync fails:** Tell user and retry the same command once. Already-synced chapters are skipped.

---

## URL Read Aloud (when user sends a URL)

**Tell user:** "Extracting article content, just a moment..."

### Step 1: Extract

```
node scripts/read-url.js "<url>" 0
```

### Step 2: Show info + ask

```
📖 {title}
{totalParagraphs} paragraphs · {totalCharacters} chars

1️⃣ Listen to full article
2️⃣ Listen to summary only
```

**STOP. Wait for user reply.**

### Step 3: Generate and send

**Tell user:** "Generating audio, about 1 minute..."

For full article: `node scripts/read-url.js "<url>" all`
For summary: write summary to file, then `node scripts/generate-text.js`

Send via message tool.

---

## Rules

- Default to read-together flow. Do NOT list a feature menu upfront.
- **ALWAYS tell user what you're doing and how long before running any command**
- **Login: ONLY manual login on computer. Do NOT send screenshots or ask for passwords via chat.**
- **If sync fails or interrupts, automatically retry once before asking user**
- Only sync the book the user selected (`--book "title"`). Do NOT sync entire library by default.
- Only omit `--book` when user explicitly says "sync all"
- Auto-detect language for TTS (zh for Chinese, en for English)
- After finishing a chapter, ask "Continue to the next chapter?"
- Channel MUST be dynamically detected from user message prefix. Never hardcode.
- ALWAYS send audio via message tool. Never just print file path.
- Do NOT use built-in TTS tools. ONLY use `read-url.js` and `generate-text.js`.
- Do NOT use web_fetch. ONLY use `read-url.js`.
