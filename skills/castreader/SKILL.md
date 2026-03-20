---
name: castreader
description: >
  Read books together with AI. Pick a book from your Kindle or WeRead library,
  discuss chapter by chapter, and listen aloud.
version: 3.0.1
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
- channel = platform in lowercase (telegram / whatsapp / imessage)

Parsing rules:
1. Extract platform (first word) and chatId (number after `id:`)
2. channel = platform.toLowerCase()
3. All message tool calls use the parsed channel and target

Examples:
- `[Telegram xu id:123]` → channel="telegram", target="123"
- `[WhatsApp John id:456]` → channel="whatsapp", target="456"

---

## Core Flow: Read Together

### Entry Point

1. Check local library at `~/castreader-library/index.json`
   - Has synced books → Show local book list, user can pick one to read
   - Empty or missing → Guide user to sync
2. User wants a book not in local library → Sync that specific book

### Show Local Book List

```
cat ~/castreader-library/index.json
```

Format as numbered list:
```
Your bookshelf (N books)

1. "Kafka on the Shore" — Haruki Murakami · 58 chapters
2. "Anne of Green Gables" — L.M. Montgomery · 40 chapters
...

Pick one to start reading! (Want a new book? Tell me to sync from Kindle/WeRead)
```

### After User Picks a Book → Show Table of Contents

```
cat ~/castreader-library/books/<id>/meta.json
```

List chapter TOC:
```
"Kafka on the Shore" — Table of Contents:

1. Copyright
2. Preface
3. Translator's Note
4. The Boy Named Crow
5. Chapter 1
...

Where to start? (Say a chapter number or name)
```

### After User Picks a Chapter → Read Together

```
cat ~/castreader-library/books/<id>/chapter-NN.md
```

After reading the content:
- Give chapter overview / discussion points
- Enter free conversation: discuss, ask questions, summarize, connect to other chapters
- User can say "next chapter" to continue

### Read Aloud (when user says "read it aloud" / "listen" / "play")

1. Save chapter content to temp file:
```
echo "<chapter text>" > /tmp/castreader-chapter.txt
```

2. Generate audio:
```
node scripts/generate-text.js /tmp/castreader-chapter.txt <language>
```
language: use `zh` for Chinese books, `en` for English books — detect automatically from content.

3. Send MP3:
```json
{"action":"send", "target":"<chatId>", "channel":"<channel>", "filePath":"/tmp/castreader-chapter.mp3", "caption":"🔊 \"Book Title\" Chapter N"}
```

### Sync Books (when library is empty or user wants a new book)

Triggered when user wants a book not in local library, or library is empty.

Ask user: "Do you use Kindle or WeRead?"

**Three-phase flow: Login → List remote shelf → Sync selected book**

#### Phase 1: Login (check + interactive)

```
node scripts/sync-login.js kindle start
```
or `weread` instead of `kindle`.

Output: JSON `{"event":"...", "step":"...", "screenshot":"...", "message":"...", "loggedIn":...}`

**Handle each event:**

- `event: "already_logged_in"` → Tell user "Already logged in!" and skip to Phase 2.
- `event: "login_step"` → Login is needed. **Ask user to choose:**

```
You need to log in to your Amazon/WeRead account. Choose a method:

1️⃣ I'll log in on my computer (browser is open, complete login there)
2️⃣ Provide credentials for automated login
```

**STOP and wait for user reply.**

##### Option 1: User logs in manually on computer

Tell user: "Please complete the login in the browser window on your computer. Let me know when done."

Then poll login status every 15 seconds:
```
node scripts/sync-login.js kindle status
```
- If `loggedIn: true` → Tell user "Login successful!" and proceed to Phase 2.
- If `loggedIn: false` after user says they logged in → Send screenshot to user, ask them to check.
- Keep polling until `loggedIn: true` or user cancels.

##### Option 2: Automated login via credentials

Ask user for credentials step by step. Each step: enter text → screenshot → next step.

```
node scripts/sync-login.js kindle input "<user's reply text>"
```

- If `event: "login_complete"` → Proceed to Phase 2.
- If `event: "login_step"` with `step: "password"` → Ask for password.
- If `event: "login_step"` with `step: "2fa"` → Ask for verification code.
- If `event: "login_step"` with `step: "captcha"` → Send screenshot, ask user to type characters.
- `step: "wechat_qr"` → Send screenshot, tell user to scan QR with WeChat. Poll every 10s:
  ```
  node scripts/sync-login.js weread status
  ```
  Until `loggedIn: true`.

**Send screenshots to user:**
```json
{"action":"send", "target":"<chatId>", "channel":"<channel>", "filePath":"<screenshot path>", "caption":"<message>"}
```

#### Phase 2: Close login Chrome

```
node scripts/sync-login.js kindle stop
```

#### Phase 3: Sync Books (three scenarios)

##### Scenario A: User already named a book (e.g. "sync Kafka on the Shore")

Sync the specified book directly, skip `--list`:
```
node scripts/sync-books.js kindle --book "Kafka on the Shore"
```

##### Scenario B: User is browsing (e.g. "what books do I have on Kindle?")

List remote shelf first (no sync, list only):
```
node scripts/sync-books.js kindle --list
```
Output: `{"books":[{"title":"...","author":"..."},...]}`

Show to user:
```
Your Kindle library (N books)

1. "Kafka on the Shore" — Haruki Murakami
2. "Thinking, Fast and Slow" — Daniel Kahneman
...

Which one do you want to read?
```

**STOP and wait for user to pick a book.** Then sync:
```
node scripts/sync-books.js kindle --book "Kafka on the Shore"
```

##### Scenario C: User explicitly requests full sync (e.g. "sync all my books")

```
node scripts/sync-books.js kindle
```
Without `--book`, syncs all unsynced books.

#### Sync Script Output

The script outputs JSON events on stdout:
- `{"event":"wechat_qr","screenshot":"..."}` → Send QR screenshot to user: "Scan this QR code with WeChat to log in to WeRead. Sync will start automatically after login."
- `{"event":"login_required"}` → Re-run Phase 1.
- `{"event":"login_complete"}` → "Login successful! Syncing..."
- Final: `{"success":true,"booksSynced":N,"totalBooks":M,...}`

Sync complete → Automatically enter read-together flow (show TOC, ask where to start).

---

## URL Read Aloud (when user sends a URL)

### Step 1: Extract

```
node scripts/read-url.js "<url>" 0
```

Returns: `{ title, language, totalParagraphs, totalCharacters, paragraphs[] }`

### Step 2: Show info + ask

```
📖 {title}
🌐 {language} · 📝 {totalParagraphs} paragraphs · 📊 {totalCharacters} chars

📋 Summary: {2-3 sentence summary}

1️⃣ Listen to full article
2️⃣ Listen to summary only
```

**STOP. Wait for user reply.**

### Step 3a: Full article (user chose 1)

```
node scripts/read-url.js "<url>" all
```

Send audio:
```json
{"action":"send", "target":"<chatId>", "channel":"<channel>", "filePath":"<audioFile>", "caption":"🔊 {title}"}
```

### Step 3b: Summary only (user chose 2)

```
echo "<summary>" > /tmp/castreader-summary.txt
node scripts/generate-text.js /tmp/castreader-summary.txt <language>
```

Send audio:
```json
{"action":"send", "target":"<chatId>", "channel":"<channel>", "filePath":"/tmp/castreader-summary.mp3", "caption":"📋 Summary: {title}"}
```

---

## Rules

- Default to read-together flow. Do NOT list a feature menu upfront.
- User mentions a book title / chapter / "I want to read" → Enter read-together flow
- User sends a URL → URL read-aloud flow
- **Only sync the book the user selected** (`--book "title"`). Do NOT sync the entire library by default.
- Only omit `--book` when user explicitly says "sync all books" / "sync everything"
- Auto-detect language for TTS (zh for Chinese books, en for English books)
- After finishing a chapter, proactively ask "Continue to the next chapter?"
- The message tool's channel MUST be dynamically detected from the user message prefix. Never hardcode telegram.
- ALWAYS send audio files using the `message` tool with `target` and `channel`. Never just print the file path.
- Do NOT use built-in TTS tools. ONLY use `read-url.js` and `generate-text.js`.
- Do NOT use web_fetch. ONLY use `read-url.js`.
