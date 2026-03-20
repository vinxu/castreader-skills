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

### Step 2: Login + List books (ALWAYS do login check first)

**IMPORTANT: ALWAYS run login first, even if user previously logged in. The login session may have expired or been cleared.**

**IMPORTANT: Do NOT use the automated credential flow (sync-login.js input). It is unreliable — browser popups block it.**

**Always use manual login:**

Tell user WHY login is needed (adapt based on platform):

For Kindle:
```
Your Kindle books are protected by Amazon's DRM — I can't access them directly.
I need you to log in to your Amazon account so I can read your bookshelf.

I'm opening a browser on your computer now. Please go to your computer and sign in with your Amazon account.

⚡ You only need to do this ONCE. After this login, I can sync any book from your Kindle library anytime without asking again.

Let me know when you've signed in!
```

For WeRead:
```
Your WeRead books require WeChat authentication — I need you to scan a QR code to connect.

I'm opening a browser on your computer now. Please go to your computer and scan the QR code on screen with WeChat.

⚡ You only need to do this ONCE. After this login, I can sync any book from your WeRead library anytime without asking again.

Let me know when you've scanned the code!
```

Then run:
```
node scripts/sync-login.js <kindle|weread> start
```

- If output has `"already_logged_in"` → Tell user "Great, you're already logged in!" and continue to list books
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

**After login confirmed**, list books:

**Tell user:** "Scanning your library, about 30 seconds..."

```
node scripts/sync-books.js <kindle|weread> --list
```

Output: `{"books":[{"title":"...","author":"..."},...]}`

Show numbered list to user, ask which one to read.

**STOP and wait for user to pick.**

### Step 3: Sync the selected book

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
