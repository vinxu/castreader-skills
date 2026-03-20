# CastReader Skill v3.0 — 完整参考文档

> 最后更新: 2026-03-20

---

## 一、产品定位

### 一句话

从你的 Kindle / 微信读书书架选一本书，和 AI 一起读、一起听。

### 为什么不是"图书馆管理"

纯 md 文本 cat/grep 和用户自己把 epub 丢给 Claude 没区别。Skill 的差异化在于：

1. **同步引擎是壁垒** — 用户的书锁在 Kindle/WeRead 里导不出来，CastReader 能一键同步
2. **共读是持续交互** — 逐章读 + 讨论 + 听，不是一锤子买卖
3. **TTS 朗读是 Claude 做不到的** — 生成 MP3 发到手机，通勤听书

### 对比：CastReader vs 手动上传 EPUB

| | CastReader | 手动上传 EPUB |
|---|---|---|
| 获取书籍 | 选一本，一键同步 | 找 DRM-free EPUB，转换，上传 |
| Kindle 书 | 自动同步 | 无法导出 |
| 微信读书 | 自动同步 | 无法导出 |
| 阅读方式 | 逐章共读 + AI 讨论 | 整本丢进去，丢失结构 |
| 朗读 | 自然 TTS，MP3 发到手机 | 不支持 |
| 多本书 | 持久化书库，随时切换 | 每次重新上传 |

### 定价

**完全免费，无限制，无需注册。** 不要提 30 min/month 或付费计划。

### 支持平台

Telegram / WhatsApp / iMessage — 所有 OpenClaw 支持的 IM 平台。

---

## 二、核心交互流程

### 用户旅程

```
用户: "我想读书" / 首次使用
  ↓
Step 1: 检查本地书库
  → ~/castreader-library/index.json 有书 → 展示书单
  → 为空 → 引导同步（问 Kindle 还是微信读书）
  ↓
Step 2: 选一本书
  → 用户选书（本地有 → 直接读；本地没有 → 先同步再读）
  → 读取 meta.json → 展示目录
  ↓
Step 3: 逐章共读
  → 用户选章 → 读取 chapter-NN.md → 章节概览 + 讨论
  → 自由对话：提问、总结、联系其他章节
  → "下一章" → 继续
  ↓
Step 4: 朗读（随时触发）
  → "念给我听" → generate-text.js → MP3 发到手机
  ↓
Loop: 继续下一章 / 换书 / 讨论
```

### 入口判断规则

| 用户输入 | 走哪条路 |
|----------|----------|
| 提到书名 / 章节 / "我想读书" | 共读流程 |
| 发 URL | URL 朗读流程 |
| 书库为空 | 引导同步 |
| 其他 | 默认共读，不列功能菜单 |

---

## 三、同步引擎

### 三种同步场景

| 场景 | 触发条件 | 命令 |
|------|----------|------|
| A. 用户直接说书名 | "帮我同步《海边的卡夫卡》" | `--book "海边的卡夫卡"` |
| B. 用户不确定读什么 | "看看我 Kindle 有什么书" | `--list` → 选书 → `--book` |
| C. 全量同步 | "把我所有书都同步下来" | 不带 `--book`（仅用户明确要求时） |

### 完整流程：Login → List/Sync

#### Phase 1: 登录检查

```bash
node scripts/sync-login.js <kindle|weread> start
```

输出 JSON：`{ event, step, screenshot, message, loggedIn }`

| event | 处理 |
|-------|------|
| `already_logged_in` | 跳到 Phase 2 |
| `login_step` | 问用户选手动登录 or 提供密码 |

**手动登录**：用户去电脑浏览器登录，每 15s 轮询 `sync-login.js status`

**自动登录**：用户逐步提供凭据，`sync-login.js input "text"` 填写 + 截图

**WeChat QR**：截图发给用户，用户微信扫码，每 10s 轮询直到 `loggedIn: true`

#### Phase 2: 关闭登录 Chrome

```bash
node scripts/sync-login.js <kindle|weread> stop
```

#### Phase 3: 同步

**场景 A — 直接同步指定书：**
```bash
node scripts/sync-books.js kindle --book "海边的卡夫卡"
```

**场景 B — 先列后选：**
```bash
node scripts/sync-books.js kindle --list
# 输出: {"books":[{"title":"...","author":"..."},...]}"
# 展示给用户 → 用户选 → 再跑 --book
```

**场景 C — 全量同步：**
```bash
node scripts/sync-books.js kindle          # 同步全部
node scripts/sync-books.js kindle --max 5  # 限制 5 本
```

### 同步脚本输出

| stdout JSON event | 含义 |
|-------------------|------|
| `{"event":"wechat_qr","screenshot":"..."}` | WeRead 需要 QR 登录，发截图给用户 |
| `{"event":"login_required"}` | 需要重跑 Phase 1 |
| `{"event":"login_complete"}` | 登录成功 |
| `{"books":[...]}` | --list 模式的书单 |
| `{"success":true,"booksSynced":N,...}` | 同步完成 |

### Chrome Profile

- 默认路径: `<skill-dir>/.chrome-profile/`
- 可通过 `CHROME_PROFILE` 环境变量覆盖
- 登录 session 持久化在 profile 中，后续同步无需重新登录
- **注意**: Chrome profile 不能被多进程同时使用（clawdbot-gateway 可能占用）

### Sync Server

- 端口: `18790`（可通过 `SYNC_SERVER_PORT` 环境变量覆盖）
- 路径: `scripts/sync-server.cjs`
- 由 `sync-books.js` 自动启动
- REST API: `/save`, `/read`, `/save-batch`, `/delete-glob`, `/list-books`, `/health`
- 数据写入: `~/castreader-library/`（可通过 `LIBRARY_ROOT` 环境变量覆盖）

---

## 四、本地书库结构

```
~/castreader-library/
├── index.json                          # 书库索引
│   {
│     "version": "1.0.0",
│     "books": [
│       {
│         "id": "kafka-on-shore-abc123",
│         "title": "海边的卡夫卡",
│         "author": "村上春树",
│         "totalChapters": 58,
│         "totalCharacters": 150000,
│         "source": "weread",
│         "syncedAt": "2026-03-20T10:00:00Z"
│       }
│     ],
│     "updatedAt": "2026-03-20T10:00:00Z"
│   }
│
└── books/
    └── kafka-on-shore-abc123/
        ├── meta.json                   # 书籍元数据
        │   {
        │     "title": "海边的卡夫卡",
        │     "author": "村上春树",
        │     "bookId": "wr_abc123",
        │     "language": "zh",
        │     "totalChapters": 58,
        │     "totalCharacters": 150000,
        │     "syncedAt": "2026-03-20T10:00:00Z",
        │     "source": "weread"
        │   }
        ├── chapter-01.md               # # 章节标题\n\n段落1\n\n段落2
        ├── chapter-02.md
        ├── ...
        ├── chapter-58.md
        └── full.md                     # 全书合并（所有章节拼接）
```

---

## 五、TTS 朗读

### 章节朗读

```bash
# 1. 章节内容存临时文件
echo "<chapter text>" > /tmp/castreader-chapter.txt

# 2. 生成 MP3
node scripts/generate-text.js /tmp/castreader-chapter.txt <language>
# language: zh (中文) | en (英文)，根据 meta.json 的 language 字段

# 3. 发送给用户
message tool: { action: "send", target: "<chatId>", channel: "<channel>", filePath: "/tmp/castreader-chapter.mp3", caption: "🔊《书名》第N章" }
```

### URL 朗读（次要功能）

```bash
# 提取
node scripts/read-url.js "<url>" 0
# 返回: { title, language, totalParagraphs, totalCharacters, paragraphs[] }

# 全文音频
node scripts/read-url.js "<url>" all
# 返回音频文件路径

# 文本转音频
node scripts/generate-text.js /tmp/text.txt <language>
```

### TTS API

- **Endpoint**: `POST {apiBaseUrl}/api/captioned_speech_partly`
- **默认 apiBaseUrl**: `http://api.castreader.ai:8123`
- **Model**: `kokoro`
- **关键行为**: 每次调用只处理部分文本，返回 `unprocessed_text`，需循环调用
- **重试**: 502/503/504 自动重试 3 次，指数退避

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CASTREADER_VOICE` | `af_heart` | TTS 声音 |
| `CASTREADER_SPEED` | `1.5` | 语速 |
| `CASTREADER_API_URL` | `http://api.castreader.ai:8123` | API 地址 |

---

## 六、消息平台检测

### 用户消息前缀格式

```
[<Platform> <username> id:<chatId> ...]
```

### 解析规则

1. Platform = 第一个词（Telegram / WhatsApp / iMessage）
2. chatId = `id:` 后面的数字
3. channel = Platform 小写

### 示例

| 前缀 | channel | target |
|------|---------|--------|
| `[Telegram xu id:123]` | `telegram` | `123` |
| `[WhatsApp John id:456]` | `whatsapp` | `456` |
| `[iMessage alice id:789]` | `imessage` | `789` |

### 发送消息

```json
{
  "action": "send",
  "target": "<chatId>",
  "channel": "<channel>",
  "filePath": "<文件路径>",
  "caption": "<消息文字>"
}
```

**规则**: channel 必须从用户消息前缀动态检测，**绝不硬编码** telegram。

---

## 七、脚本清单

| 脚本 | 用途 | 关键参数 |
|------|------|----------|
| `sync-login.js` | 登录编排（Kindle/WeRead） | `<source> <start\|input\|status\|stop>` |
| `sync-books.js` | 同步书籍到本地 | `<source> [--list] [--book "title"] [--max N]` |
| `sync-server.cjs` | HTTP 同步服务（接收 Extension 数据） | 自动启动，端口 18790 |
| `read-url.js` | URL 提取 + 音频生成 | `<url> <0\|all\|N>` |
| `generate-text.js` | 纯文本 → MP3 | `<textFile> [language]` |
| `extract.js` | URL 文本提取 | `<url>` |
| `read-aloud.js` | 浏览器内朗读 | `<url>` |
| `test-sync.js` | 单元测试（45 tests） | `node --test` |
| `test-e2e-sync.js` | E2E 集成测试 | `<weread\|kindle\|all>` |

---

## 八、Kindle 同步技术细节

### 架构：OCR-Direct

- 文本 100% 来自 tesseract-wasm OCR，不做 glyph 解码
- OCR word bbox = 高亮定位
- 段落分割由 OCR 决定（tesseract 按视觉段落分割）
- token 数据仅用于：页面选择（anchor）、双栏检测、pageBounds 计算

### 流程

1. Puppeteer 打开 Kindle Cloud Reader → 扫描书库
2. 逐本点击打开 → 触发 Extension 的 OCR 同步
3. Extension 拦截 KindleModuleManager 获取 token + 布局数据
4. tesseract-wasm 在 offscreen document 运行 OCR
5. 同步完成 → 返回书库 → 下一本

### 翻页检测

区分 batch 预取 vs 真翻页：`kindle-render` 属性变化时必须检查 blob/页码也变了。

---

## 九、微信读书同步技术细节

### 架构：三层 Script 协作

| Script | World | 作用 |
|--------|-------|------|
| `weread-intercept.content.ts` | main world, document_start | 拦截 fetch 获取章节数据 |
| `weread-hook.content.ts` | isolated world | MutationObserver 监听 preRenderContainer |
| `weread.ts` (special extractor) | content script | 解析 Canvas 布局数据，提取文本 |

### 反盗版加密过滤

微信读书单栏模式每章有 4~10 个 preRenderContainer，仅 1 个正常，其余加密（字符重映射）。

**识别规则**: `<style>` 内 CSS 缩进 20 空格 = 正常，24 空格 = 加密（差 8 字节，4 本书验证）

### 同步流程

1. Puppeteer 打开微信读书 → QR 登录
2. 检测分页/滚动模式 → 必要时切换到滚动模式
3. 打开 TOC → 逐章点击 → 提取 Canvas 布局数据
4. mergeLinesToParagraphs 合并行为段落
5. 保存到 sync server

---

## 十、产品矩阵

| 产品 | 状态 | 说明 |
|------|------|------|
| Chrome Extension | 已发布 v1.0.3 | 网页 TTS + 段落高亮 |
| OpenClaw Skill | 已发布 v3.0.0 | 共读共听（本文档） |
| Web Player | 已上线 | castreader.ai/s/{shareId} |
| iOS App | 已发布 | Swift/SwiftUI，本地 Kokoro CoreML |
| Android App | 已发布 | Kotlin/Compose，ExoPlayer |
| API Server | 运行中 | api.castreader.ai:8123 |

---

## 十一、已实现但未纳入 Skill 的功能

### Desktop-Mobile Sync（Send to Phone）

Extension 📱按钮 → Share API → ClawdBot 推送 Telegram → Web Player 播放。
已实现，但作为 Extension 功能，不是 Skill 的一部分。

### Kindle Live Session（SSE 长连接）

手机远程控制桌面 Kindle 翻页，实现无感连续听书。
SSE 架构：手机 ← Server → 桌面 Content Script。
已实现代码，待端到端测试。

---

## 十二、测试体系

### 单元测试（test-sync.js）

```bash
node --test scripts/test-sync.js
# 45 tests, 7 suites
```

| 层级 | 测试数 | 覆盖 |
|------|--------|------|
| L1 纯逻辑 | 13 | mergeLinesToParagraphs、CLI 参数、书名匹配 |
| L2 Sync Server | 12 | 全部 REST endpoint + 安全 |
| L3 Library 读取 | 10 | 共读流程模拟 + 空库场景 |
| L4 CLI 集成 | 3 | exit code + usage 输出 |
| L4b SKILL.md 合约 | 7 | frontmatter、flag、场景、规则 |

### E2E 集成测试（test-e2e-sync.js）

```bash
CHROME_PROFILE=<path> node scripts/test-e2e-sync.js weread    # 测试 WeRead
CHROME_PROFILE=<path> node scripts/test-e2e-sync.js kindle    # 测试 Kindle
CHROME_PROFILE=<path> node scripts/test-e2e-sync.js all       # 测试全部
```

测试内容：
- `--list` 列远端书单（数据格式、无重复、有 title/author）
- `--book` 同步指定书 + 验证完整数据结构（index.json / meta.json / chapter-NN.md / full.md）
- 重复同步跳过（`Skipping` + `booksSynced: 0`）
- 不匹配书名处理（`booksSynced: 0` + `No book matching` 提示）
- 反盗版加密检查（WeRead，字符正常率 > 50%）
- OCR 质量检查（Kindle，可读字符率 > 70%）

### E2E 测试基线（v3.0.0, 2026-03-20）

| 平台 | 通过率 | 书名 | 章节数 | 字符数 | 关键指标 |
|------|--------|------|--------|--------|----------|
| WeRead | 12/13 (92%) | 孽子 — 白先勇 | 70 章 | 801,964 | 反盗版: 70/70 通过 |
| Kindle | 12/12 (100%) | English Fairy Tales | 44 章 | 321,582 | OCR 质量: 99.8% |

WeRead 唯一失败: Chrome profile exists 检查（非功能性，已修复）。

### Chrome Profile 注意事项

- **不能拷贝**: Chrome profile 整体拷贝会导致 `Target closed` crash
- **推荐**: 使用已有 profile（如 `<skill-dir>/.chrome-profile/`），设置 `CHROME_PROFILE` 环境变量
- **持久化**: E2E 测试默认使用 `/tmp/castreader-e2e-profile/`，登录 session 跨测试保留
- **clawdbot-gateway 冲突**: 如果 gateway 正在使用同一 profile，需先停止 gateway

---

## 十三、关键文件索引

| 文件 | 用途 |
|------|------|
| `SKILL.md` | Skill 交互流程定义（OpenClaw 读取） |
| `README.md` | ClawHub 展示页 |
| `_meta.json` | 版本元数据 |
| `package.json` | 依赖 + 脚本 |
| `scripts/sync-books.js` | 核心同步脚本（1545 行） |
| `scripts/sync-login.js` | 登录编排（452 行） |
| `scripts/sync-server.cjs` | 同步服务（197 行） |
| `scripts/generate-text.js` | TTS 生成 |
| `scripts/read-url.js` | URL 提取 |
| `references/castreader-api.md` | API 参考 |
| `chrome-extension/` | 打包好的 Extension（fallback） |
| `docs/skill-v3-complete-reference.md` | 本文档 |

---

## 十四、Skill 行为规则总结

1. 默认走共读流程，不列功能菜单
2. 同步时只同步用户选的那一本书（`--book`），不默认全量
3. 只有用户明确说"同步所有书"才不带 `--book`
4. 朗读自动检测语言（zh/en）
5. 每章读完主动问"继续下一章？"
6. channel 从用户消息前缀动态检测，不硬编码
7. 音频必须用 message tool 发送，不打印文件路径
8. TTS 只用 `generate-text.js` 和 `read-url.js`，不用内置 TTS
9. URL 提取只用 `read-url.js`，不用 web_fetch

---

## 十五、链接

- **网站**: https://castreader.ai
- **OpenClaw**: https://castreader.ai/openclaw
- **Chrome Web Store**: https://chromewebstore.google.com/detail/castreader-tts-reader/foammmkhpbeladledijkdljlechlclpb
- **Edge Add-ons**: https://microsoftedge.microsoft.com/addons/detail/niidajfbelfcgnkmnpcmdlioclhljaaj
- **ClawHub**: https://clawhub.com/castreader
