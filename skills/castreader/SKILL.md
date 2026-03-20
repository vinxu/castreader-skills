---
name: castreader
description: >
  Read books together with AI. Pick a book from your Kindle or WeRead library,
  discuss chapter by chapter, and listen aloud.
version: 3.1.0
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

**Users are on their phone. They cannot see what's happening on the server. Every long operation MUST follow this pattern:**

1. **BEFORE starting**: Tell the user WHAT you're about to do and HOW LONG it will take
2. **DURING**: Send progress updates for anything longer than 30 seconds
3. **AFTER**: Confirm completion and immediately show the next step

**Time estimates to use:**
- Listing books: "~30 seconds"
- Syncing a short book (<20 chapters): "1-3 minutes"
- Syncing a long book (>50 chapters): "5-10 minutes"
- Generating audio for a chapter: "~1 minute"

**Example of GOOD communication:**
```
I'll sync "A Journey to the Centre of the Earth" from your Kindle now.
This usually takes 2-3 minutes. I'll update you on progress...

📖 Syncing... 25% done
📖 Syncing... 60% done
📖 Done! 43 chapters synced. Here's the table of contents:
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
cat ~/castreader-library/index.json
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

### Step 2: Login

**IMPORTANT: Do NOT use the automated credential flow (sync-login.js input). It is unreliable — browser popups block it.**

**Always use manual login:**

Tell user:
```
To access your Kindle/WeRead bookshelf, I need you to log in first.

I'm opening a browser on your computer — please go to your computer and log in there.
For Kindle: enter your Amazon email and password.
For WeRead: scan the QR code with WeChat.

⚡ This is a ONE-TIME setup — once you log in, future syncs won't need login again.

Let me know when you're done!
```

Then run:
```
node scripts/sync-login.js <kindle|weread> start
```

- If output has `"already_logged_in"` → Tell user "Already logged in!" and skip to Step 3
- If output has `"login_step"` → Browser is open, user needs to go log in
  - For WeRead: tell user "Scan the QR code with WeChat on your computer screen"
  - For Kindle: tell user "Enter your Amazon credentials in the browser on your computer"

Poll every 15 seconds:
```
node scripts/sync-login.js <kindle|weread> status
```

When `loggedIn: true` → Tell user "Login successful!" then:
```
node scripts/sync-login.js <kindle|weread> stop
```

### Step 3: List books

**Tell user first:** "Scanning your library, about 30 seconds..."

```
node scripts/sync-books.js <kindle|weread> --list
```

Output: `{"books":[{"title":"...","author":"..."},...]}`

Show numbered list to user, ask which one to read.

**STOP and wait for user to pick.**

### Step 4: Sync the selected book

**Tell user first:** "Syncing '[book title]' now. This takes about 2-5 minutes depending on the book length. I'll keep you updated on progress..."

```
node scripts/sync-books.js <kindle|weread> --book "Book Title"
```

**While sync is running:** The script outputs progress to stderr. Parse and send periodic updates to the user:
- At 25%: "📖 Syncing... 25% done"
- At 50%: "📖 Halfway there..."
- At 75%: "📖 Almost done, 75%..."
- When complete: "📖 Done! [N] chapters synced."

**If sync fails or gets interrupted:** Tell user "The sync got interrupted at X%. Let me retry..." and run the same command again. The script will resume from where it left off (already-synced chapters are skipped).

After sync complete → Show table of contents, ask where to start reading.

### Sync Script Output

JSON events on stdout:
- `{"books":[...]}` → Book list from --list
- `{"success":true,"booksSynced":N,...}` → Sync complete
- `{"event":"wechat_qr","screenshot":"..."}` → WeRead QR login needed
- `{"event":"login_required"}` → Need login, go back to Step 2

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
