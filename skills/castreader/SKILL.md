---
name: castreader
description: >
  Read books together with AI. Pick a book from your Kindle or WeRead library,
  discuss chapter by chapter, and listen aloud.
version: 3.0.0
metadata:
  openclaw:
    emoji: "📖"
    requires:
      anyBins: ["node"]
    os: ["darwin", "linux", "win32"]
    homepage: https://castreader.ai/openclaw
---

# CastReader — 和 AI 一起读书听书

## Setup (once per session)

```
cd <skill-directory> && npm install --silent 2>/dev/null
```

## 平台与用户检测

用户消息前缀格式：`[<Platform> <username> id:<chatId> ...]`
- Platform = Telegram / WhatsApp / iMessage
- chatId = message tool 的 target
- channel = platform 小写（telegram / whatsapp / imessage）

解析规则：
1. 从前缀提取 platform（第一个词）和 id:后面的数字
2. channel = platform.toLowerCase()
3. 所有 message tool 调用使用解析出的 channel 和 target

示例：
- `[Telegram xu id:123]` → channel="telegram", target="123"
- `[WhatsApp John id:456]` → channel="whatsapp", target="456"

---

## 核心流程：共读共听

### 入口判断

1. 先检查本地书库 `~/castreader-library/index.json`
   - 有已同步的书 → 展示本地书单，用户可直接选读
   - 为空或不存在 → 引导同步
2. 用户想读一本新书（本地没有）→ 引导同步那一本

### 展示本地书单

```
cat ~/castreader-library/index.json
```

格式化为编号列表：
```
📚 你的书架 (N 本)

1. 《海边的卡夫卡》 — 村上春树 · 58章
2. 《绿山墙的安妮》 — 蒙哥马利 · 40章
...

选一本开始读吧！（想读新书？告诉我去 Kindle/微信读书同步）
```

### 用户选书后 → 展示目录

```
cat ~/castreader-library/books/<id>/meta.json
```

列出章节目录：
```
📖《海边的卡夫卡》目录：

1. 版权信息
2. 中文版序言
3. 译序
4. 叫乌鸦的少年
5. 第1章
...

从哪章开始？（直接说章节号或章节名）
```

### 用户选章后 → 共读

```
cat ~/castreader-library/books/<id>/chapter-NN.md
```

读取内容后：
- 给出章节概览 / 讨论要点
- 进入自由对话：讨论、提问、总结、联想其他章节
- 用户可随时说"下一章"继续

### 朗读（用户说"念给我听"/"朗读"/"读给我听"时）

1. 将章节内容存为临时文件：
```
echo "<chapter text>" > /tmp/castreader-chapter.txt
```

2. 生成音频：
```
node scripts/generate-text.js /tmp/castreader-chapter.txt <language>
```
language: 中文书用 `zh`，英文书用 `en`，根据内容自动判断。

3. 发送 MP3：
```json
{"action":"send", "target":"<chatId>", "channel":"<channel>", "filePath":"/tmp/castreader-chapter.mp3", "caption":"🔊 《Book Title》 Chapter N"}
```

### 同步书籍（书库为空 or 用户想读新书）

当用户想读一本本地没有的书，或书库为空时触发。

先问用户："你用的是 Kindle 还是微信读书？"

**Three-phase flow: Login → 列出远端书单 → 同步选定的书**

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
需要登录你的 Amazon/WeRead 账号，请选择登录方式：

1️⃣ 我去电脑上登录（浏览器已打开，请在电脑上完成登录）
2️⃣ 提供账号密码，帮我自动登录
```

**STOP and wait for user reply.**

##### Option 1: User logs in manually on computer

Tell user: "请在电脑上打开的浏览器中完成登录，登录完成后告诉我。"

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

#### Phase 3: 同步书籍（三种场景）

##### 场景 A：用户已经说了书名（如"帮我同步《海边的卡夫卡》"）

直接同步指定书，跳过 `--list`：
```
node scripts/sync-books.js kindle --book "海边的卡夫卡"
```

##### 场景 B：用户不确定读什么（如"看看我 Kindle 有什么书"）

先列出远端书架（不同步，只列表）：
```
node scripts/sync-books.js kindle --list
```
Output: `{"books":[{"title":"...","author":"..."},...]}`

展示给用户选择：
```
📚 你的 Kindle 书架 (N 本)

1. 《海边的卡夫卡》 — 村上春树
2. 《Thinking, Fast and Slow》 — Daniel Kahneman
...

想读哪本？
```

**STOP and wait for user to pick a book.** Then sync:
```
node scripts/sync-books.js kindle --book "海边的卡夫卡"
```

##### 场景 C：用户明确要求同步全部（如"把我所有书都同步下来"）

```
node scripts/sync-books.js kindle
```
不带 `--book`，同步全部未同步的书。

#### 同步脚本输出

The script outputs JSON events on stdout:
- `{"event":"wechat_qr","screenshot":"..."}` → Send QR screenshot to user: "📱 请在微信中长按识别此二维码登录微信读书，登录后会自动开始同步。"
- `{"event":"login_required"}` → Re-run Phase 1.
- `{"event":"login_complete"}` → "登录成功！正在同步..."
- Final: `{"success":true,"booksSynced":N,"totalBooks":M,...}`

Sync complete → 自动进入共读流程（展示目录，问从哪章开始）。

---

## URL 朗读（用户发 URL 时）

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

- 默认走共读流程，不要一上来就列功能菜单
- 用户提到书名 / 章节 / "我想读书" → 直接进入共读
- 用户发 URL → URL 朗读
- **同步时只同步用户选的那一本书**（`--book "书名"`），不要默认同步整个书架
- 只有用户明确说"同步所有书"/"全部同步"时，才不带 `--book` 参数
- 朗读时自动检测语言（中文书用 zh，英文书用 en）
- 每次读完一章，主动问"继续下一章？"
- message tool 的 channel 必须从用户消息前缀动态检测，不硬编码 telegram
- ALWAYS send audio files using the `message` tool with `target` and `channel`. Never just print the file path.
- Do NOT use built-in TTS tools. ONLY use `read-url.js` and `generate-text.js`.
- Do NOT use web_fetch. ONLY use `read-url.js`.
