---
name: castreader
description: >
  Read books together with AI. Pick a book from your Kindle or WeRead library,
  discuss chapter by chapter, and listen aloud.
version: 3.4.0
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

Detect the user's channel from the inbound metadata (system prompt JSON or message prefix).

**From structured metadata** (openclaw.inbound_meta.v1):
- `channel` field → the channel name
- `chat_id` field → target for the message tool

**From legacy prefix** `[<Platform> <username> id:<chatId> ...]`:
- Platform = Telegram / WhatsApp / iMessage
- chatId = target for the message tool

Examples:
- `channel: "telegram"`, `chat_id: "123"` → channel="telegram", target="123"
- `channel: "openclaw-weixin"`, `chat_id: "xxx@im.wechat"` → channel="openclaw-weixin" (微信)
- `[Telegram xu id:123]` → channel="telegram", target="123"

**微信用户识别**: channel 为 `openclaw-weixin`，或 chat_id 以 `@im.wechat` 结尾。

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

## SPEED RULES — Minimize API round-trips

**Every tool call costs 3-5 seconds. Combine steps aggressively.**

1. **NEVER check local library THEN search online as two separate turns.** Instead: run ONE bash command that checks local AND searches if not found.
2. **NEVER explain what you're about to do, then do it in a separate turn.** Combine the explanation message AND the tool call in the SAME turn.
3. **Prefer `search-book.js` over `cat` for all book operations** — it's faster and outputs structured JSON.
4. **Batch reads**: Use `--read 5-8` to read multiple chapters in one call, not chapter by chapter.
5. **When user says a book name**: immediately run the search/check — don't ask clarifying questions first.

---

## Core Flow: Read Together

### Entry Point — User mentions a book title

**Do this in ONE turn (one bash tool call):**

```bash
# Check local first, search WeRead if not found — ALL IN ONE COMMAND
LOCAL=$(node scripts/search-book.js "书名关键词" --summary 2>/dev/null); if [ $? -eq 0 ]; then echo "$LOCAL"; else node scripts/sync-books.js weread --search "书名关键词"; fi
```

- Local hit → show summary + TOC, ask where to start
- Local miss → show search results, ask which one

### Show Local Book List

```
cat ~/castreader-library/index.json 2>/dev/null || echo '{"books":[]}'
```

Format as numbered list, then ask which one to read.

### After User Picks a Book → Show Table of Contents

```
node scripts/search-book.js <bookId> --summary
```

Shows title, author, chapter list with character counts. Ask where to start.

### After User Picks a Chapter → Read Together

```
node scripts/search-book.js <bookId> --read <N>
```

For multiple consecutive chapters: `--read 5-8`

- Give chapter overview / discussion points
- Free conversation: discuss, questions, summary
- User says "next chapter" → continue

### Search Book Content (user asks "find the scene where..." / "哪一章提到了...")

**IMPORTANT: Do NOT read chapters one by one to search. Use `search-book.js --grep` instead.**

```
node scripts/search-book.js <bookId> --grep "关键词"
```

This searches ALL chapters instantly (<1 second) and returns matching lines with context.
Then read only the specific chapter(s) that matched:

```
node scripts/search-book.js <bookId> --read <matched-chapter-number>
```

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
  - If user provides email and password:
    1. **MUST wait for the previous script to fully exit first** (do NOT run two scripts at once — they share the same Chrome profile and will conflict)
    2. Then re-run with credentials: `node scripts/sync-books.js kindle --list --email "user@email.com" --password "password123"`
    3. Parse user message to extract email (contains @) and password (the other part). Example: "vinxu@gmail.com MyPass123" → email="vinxu@gmail.com", password="MyPass123"
  - If user says they'll log in themselves → Wait for the current script to detect login completion
- `{"event":"kindle_2fa_required","screenshot":"/path/to/screenshot.png"}` → **Send the screenshot to user via message tool**, then tell user: "亚马逊需要验证码，请查看手机短信或邮箱，把验证码发给我"
- `{"event":"kindle_login_error","message":"..."}` → Tell user the error message, ask them to retry
- stderr "Already logged in" → Login was automatic, no user action needed
- Script exits with error → Tell user and retry

**IMPORTANT for WeRead QR:** The script outputs a JSON line with `event: "wechat_qr"` and `screenshot` path. You MUST read that image file and send it to the user via the message tool so they can scan it on their phone. Do NOT just tell them to look at the computer screen.

**微信用户 QR 特殊处理:** 如果用户通过微信聊天（channel 为 `openclaw-weixin`），发送 QR 图片后提示"长按图片即可扫码登录微信读书"，比 Telegram 用户更方便（不需要切换 App）。

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

## Search & Add Book (WeRead only)

When user mentions a book that's NOT in the local library (e.g., "我想看三体", "帮我找一本书"), use this flow:

### Step 1: Search

**Tell user:** "正在微信读书搜索《书名》..."

```
node scripts/sync-books.js weread --search "关键词"
```

**Handle output:**
- `{"event":"search_results","keyword":"...","books":[...]}` → Show numbered list with title, author, and intro (if available). Ask user to pick one.
- `{"event":"wechat_qr","screenshot":"..."}` → Login needed first. Send QR image to user, wait for login, then re-run search.
- No results → Tell user, suggest different keywords.

**STOP. Wait for user to pick a book.**

### Step 2+3: Add to shelf AND sync (combine in ONE turn)

After user picks a book (e.g., "第一个"):

**Tell user AND run the command in the SAME turn.** Do NOT split into separate messages.

```bash
# Add to shelf then immediately sync — ONE bash call
node scripts/sync-books.js weread --add-shelf "readerBookId" && node scripts/sync-books.js weread --book "书名"
```

**Handle add-shelf output:**
- `{"event":"added_to_shelf","title":"...","alreadyOnShelf":true}` → Already on shelf, sync proceeds.
- `{"event":"added_to_shelf","title":"...","success":true}` → Added, sync proceeds.
- `{"event":"added_to_shelf","title":"...","success":false}` → Failed. Tell user to add manually in WeRead app, then retry sync only.

After sync → Show table of contents, start reading together.

### Combined Example

```
User: "我想看三体"
Bot: "正在微信读书搜索《三体》..."
     → runs --search "三体"
     → "找到以下结果：\n1. 三体 - 刘慈欣\n2. 三体II：黑暗森林 - 刘慈欣\n..."
     → "你想看哪一本？"

User: "第一个"
Bot: "正在将《三体》加入你的书架..."
     → runs --add-shelf "readerBookId"
     → "已加入书架！正在同步内容，大约需要 1-2 分钟..."
     → runs --book "三体"
     → Shows TOC, starts reading
```

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
- **微信用户默认中文**: 如果 channel 是 `openclaw-weixin`，默认 TTS language 为 zh（除非书籍明确是英文）
- After finishing a chapter, ask "Continue to the next chapter?"
- Channel MUST be dynamically detected from user message prefix. Never hardcode.
- ALWAYS send audio via message tool. Never just print file path.
- Do NOT use built-in TTS tools. ONLY use `read-url.js` and `generate-text.js`.
- Do NOT use web_fetch. ONLY use `read-url.js`.
