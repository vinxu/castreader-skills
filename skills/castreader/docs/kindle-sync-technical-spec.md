# CastReader Kindle/WeRead 书籍同步 — 技术规格文档

> 版本: v3.0.0 | 日期: 2026-03-19 | 状态: 已验证通过

## 1. 需求概述

### 1.1 核心目标

用户通过 Telegram 与 AI 书友交互，远程触发 Kindle/WeRead 书籍同步到本地图书馆 `~/castreader-library/`。**用户全程在 Telegram 上操作，无需接触电脑**。

### 1.2 用户旅程

```
用户(Telegram) → "同步我的Kindle书"
  → Skill 启动 Chrome → 检测登录状态
  → 如需登录 → 询问用户选择登录方式：
      ┌─ 选项1: 用户去电脑上手动登录（浏览器已打开）
      └─ 选项2: 通过Telegram提供账号密码，自动登录
  → 登录完成 → 自动同步所有未同步的书
  → 同步完成 → 用户可以讨论/搜索/朗读书中内容
```

### 1.3 设计原则

- **Telegram-first**: 用户只在 Telegram 上操作，不需要 SSH 或 VNC
- **Session 持久化**: 登录态保存在 Chrome Profile，后续同步无需重复登录
- **增量同步**: 跳过已同步的书，只同步新书
- **Chrome 扩展复用**: 复用 CastReader Chrome 扩展的 OCR 同步引擎，不重新实现

---

## 2. 系统架构

### 2.1 组件总览

```
┌─────────────────────────────────────────────────────────────┐
│ OpenClaw Skill (SKILL.md 编排)                               │
│ ├── sync-login.js  — 截图交互式登录                           │
│ ├── sync-books.js  — 自动化书籍同步                           │
│ ├── sync-server.cjs — HTTP 接收服务（接收扩展推送的文件）       │
│ └── chrome-extension/ — 预打包的 CastReader Chrome 扩展        │
├─────────────────────────────────────────────────────────────┤
│ Puppeteer (Chrome for Testing)                               │
│ ├── --load-extension → 加载 CastReader 扩展                   │
│ ├── --user-data-dir  → .chrome-profile/ 保存登录 session       │
│ └── CDP (Chrome DevTools Protocol) → 与扩展 SW 通信            │
├─────────────────────────────────────────────────────────────┤
│ CastReader Chrome 扩展                                       │
│ ├── Background SW → chrome.tabs.sendMessage / scripting API   │
│ ├── Content Script → kindle-library-sync.ts (OCR 逐页同步)    │
│ └── Sync Engine   → syncCurrentBook() → POST 到 sync-server   │
├─────────────────────────────────────────────────────────────┤
│ ~/castreader-library/                                        │
│ ├── index.json          — 书库索引                            │
│ └── books/<id>/                                              │
│     ├── meta.json       — 书籍元数据 + 目录                    │
│     ├── chapter-NN.md   — 各章节 Markdown                     │
│     └── full.md         — 全书合并                            │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 数据流

```
Phase 1 (登录):
  sync-login.js start → Puppeteer launch Chrome → navigate kindle-library
    → 截图 → JSON stdout → Skill 解析 → 发截图到 Telegram
    → 用户回复 → sync-login.js input "text" → 填字段+点按钮 → 截图 → 循环
    → login_complete → sync-login.js stop → Chrome 关闭 (session saved)

Phase 2 (同步):
  sync-books.js kindle → 启动 sync-server.cjs (localhost:18790)
    → Puppeteer launch Chrome (同 profile, 已登录)
    → 扩展 SW 加载 → findExtensionId()
    → navigate kindle-library → scrollToLoadAllBooks()
    → getKindleBookTitles() → 与 getSyncedBookTitles() 比对
    → 逐本: clickKindleBook() → sendMessageToActiveTab(SYNC_LIBRARY_START)
      → Content Script: syncCurrentBook() OCR 逐页
      → POST 章节数据到 sync-server → 写入 ~/castreader-library/
      → waitForSyncComplete() 轮询 SYNC_LIBRARY_STATUS
    → 返回 library → 下一本 → 全部完成 → 关闭 Chrome + sync-server
```

---

## 3. 脚本详细说明

### 3.1 sync-login.js — 截图交互式登录

**文件**: `scripts/sync-login.js`

**用途**: 启动 Chrome，通过截图让 Telegram 用户完成远程登录。Chrome 通过 `--remote-debugging-port=9224` 保持运行，脚本每次调用连接/断开。

#### 命令

| 命令 | 用法 | 说明 |
|------|------|------|
| `start` | `node sync-login.js kindle start` | 启动 Chrome，导航到登录页，截图返回 |
| `input` | `node sync-login.js kindle input "text"` | 在当前输入框输入文字，点击提交，截图返回 |
| `status` | `node sync-login.js kindle status` | 检查当前登录状态，截图返回 |
| `stop` | `node sync-login.js kindle stop` | 关闭 Chrome |

#### 输出格式 (JSON stdout)

```json
{
  "event": "already_logged_in | login_step | login_complete | error | stopped",
  "step": "email | password | 2fa | captcha | wechat_qr | unknown_login",
  "loggedIn": true | false,
  "screenshot": "/tmp/castreader-login/xxx.png",
  "message": "人类可读的提示信息"
}
```

#### 关键技术决策

| 决策 | 原因 |
|------|------|
| `ignoreDefaultArgs: ['--disable-extensions']` | Puppeteer 默认加 `--disable-extensions`，会阻止扩展加载 |
| `page.type()` 替代 `input.value = text` | Amazon 表单需要真实键盘事件才能触发验证，直接赋值不会提交 |
| `page.click(selector)` 替代 `el.click()` | 原生 Puppeteer click 触发完整的鼠标事件链 |
| `page.waitForNavigation()` 替代固定 `sleep(4000)` | 更可靠地等待页面跳转完成 |
| Landing 页自动点击 "Sign in" | Kindle 未登录时重定向到 `/landing` 而非直接 `/ap/signin` |
| CDP port 9224 | 避免与其他 Puppeteer 实例（默认 9222）冲突 |

#### 页面状态检测 (`detectPageState`)

```
URL 包含 /ap/signin → 检查 bodyText:
  ├── "Enter your email" / "手机号码"  → step: "email"
  ├── "Password" / "密码"              → step: "password"
  ├── "verification code" / "OTP"      → step: "2fa"
  ├── "CAPTCHA"                        → step: "captcha"
  └── 其他                              → step: "unknown_login"

URL 包含 weread + login → step: "wechat_qr"
URL 包含 /landing       → step: "landing" (自动处理)
其他                     → step: "ready"
```

### 3.2 sync-books.js — 自动化书籍同步

**文件**: `scripts/sync-books.js`

**用途**: 启动 Chrome + 扩展 + sync-server，自动扫描并逐本同步 Kindle/WeRead 书籍。

#### 命令

```bash
node scripts/sync-books.js kindle          # 同步所有 Kindle 书籍
node scripts/sync-books.js kindle --max 3  # 最多同步 3 本
node scripts/sync-books.js weread          # 同步微信读书
```

#### 自动化流程 (Kindle)

```
1. ensureDependencies()     — 自动 npm install puppeteer
2. ensureExtensionBuilt()   — 查找扩展: env > dev build > bundled > build from source
3. startSyncServer()        — 启动 localhost:18790 接收扩展推送
4. launchChrome(extPath)    — Puppeteer 启动 Chrome + 加载扩展
5. findExtensionId()        — 从 targets 中查找 chrome-extension:// URL
6. navigate kindle-library  — 导航到书库（profile 中已保存登录态）
7. waitForLogin()           — 确认已登录（如未登录输出 login_required 事件）
8. scrollToLoadAllBooks()   — 滚动页面触发懒加载所有书封面
9. getKindleBookTitles()    — 提取书名列表（从封面图 <a> 的父容器文本）
10. getSyncedBookTitles()   — 查询已同步书名（sync-server /list-books）
11. 逐本循环:
    a. 跳过已同步的书
    b. clickKindleBook()    — 点击封面进入阅读器
    c. sendMessageToActiveTab(SYNC_LIBRARY_START) — 触发扩展同步
    d. waitForSyncComplete() — 轮询 SYNC_LIBRARY_STATUS 直到 done
    e. 返回 kindle-library，重新加载书列表
12. 关闭 Chrome + sync-server
13. 输出 JSON: { success, booksSynced, totalBooks, booksAdded }
```

#### 与扩展通信 (`sendMessageToActiveTab`)

```
Browser → findServiceWorker() → CDP Session
  → Runtime.evaluate in SW context:
    → chrome.tabs.query({ active: true })
    → chrome.tabs.sendMessage(tabId, message)
    → 如果失败 → chrome.scripting.executeScript() 注入 content.js
    → 重试 sendMessage
```

#### Kindle DOM 结构

```html
<!-- 书籍瓦片：<a> 包含封面图，无 ASIN、无 href -->
<a class="_9LIp7PLRk3m1eU9xI77mx">
  <img src="https://m.media-amazon.com/images/I/xxx._SY400_.jpg" alt="">
</a>
<!-- 父容器包含标题+作者文本 -->
<div>
  <a>...</a>
  <span>Book Title</span>
  <span>Author Name</span>
</div>
```

### 3.3 sync-server.cjs — 文件接收服务

**文件**: `scripts/sync-server.cjs`
**端口**: `localhost:18790`

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 |
| `/list-books` | POST | 返回已同步书籍列表 |
| `/save-chapter` | POST | 接收章节数据，写入 `~/castreader-library/` |
| `/save-meta` | POST | 接收书籍元数据 |

### 3.4 chrome-extension/ — 预打包扩展

**目录**: `chrome-extension/` (~8.3MB)

从 `readout-desktop/.output/chrome-mv3/` 复制的完整构建产物，包含：
- Content Scripts (content.js, kindle-intercept.js 等)
- Background Service Worker (background.js)
- tesseract-wasm OCR 数据文件（Kindle 文本提取需要）
- Popup UI

**作用**: 让 sync-books.js 在任何机器上都能工作，不依赖 readout-desktop 项目。

---

## 4. 登录流程编排 (SKILL.md)

### 4.1 流程图

```
用户: "同步我的Kindle书"
        │
        ▼
  sync-login.js kindle start
        │
        ├── already_logged_in ──────────────────────┐
        │                                           │
        ▼                                           │
  login_step (需要登录)                               │
        │                                           │
        ▼                                           │
  发消息给用户: "请选择登录方式:                        │
    1️⃣ 我去电脑上登录                                │
    2️⃣ 提供账号密码自动登录"                          │
        │                                           │
        ├── 用户选 1 ──┐                              │
        │              ▼                             │
        │    "请在电脑浏览器中登录"                     │
        │    轮询 sync-login.js kindle status         │
        │    每15秒检查一次                            │
        │    loggedIn: true ──────────────────────┐   │
        │                                        │   │
        ├── 用户选 2 ──┐                          │   │
        │              ▼                         │   │
        │    "请发送你的邮箱"                      │   │
        │    sync-login.js kindle input "email"   │   │
        │    截图 → 发给用户                       │   │
        │    "请发送你的密码"                      │   │
        │    sync-login.js kindle input "pass"    │   │
        │    可能还有 2FA/CAPTCHA → 继续循环       │   │
        │    login_complete ─────────────────┐    │   │
        │                                   │    │   │
        ▼                                   ▼    ▼   ▼
  sync-login.js kindle stop (关闭 Chrome, session 已保存)
        │
        ▼
  sync-books.js kindle (启动新 Chrome, 用同一 profile)
        │
        ├── 自动登录 (session 已保存)
        ├── 扫描书库
        ├── 跳过已同步
        ├── 逐本 OCR 同步
        │
        ▼
  完成: "已同步 N 本书到你的图书馆！"
```

### 4.2 选项 1: 用户手动登录

适用场景：用户在电脑旁，或有 2FA 物理设备。

```
Skill: 发消息 "请在电脑上打开的浏览器中完成登录，登录完成后告诉我。"
Skill: 循环执行 node scripts/sync-login.js kindle status
  → loggedIn: false → 等待 15 秒 → 再查
  → loggedIn: true  → 发消息 "登录成功！" → 进入 Phase 2
  → 用户说 "登录好了" 但 loggedIn: false → 发截图给用户确认
```

### 4.3 选项 2: 自动登录

适用场景：用户不在电脑旁，纯 Telegram 远程操作。

```
Skill: "请发送你的 Amazon 邮箱"
User: "xxx@gmail.com"
Skill: node scripts/sync-login.js kindle input "xxx@gmail.com"
  → step: "password" → "请发送你的密码"
User: "mypassword"
Skill: node scripts/sync-login.js kindle input "mypassword"
  → step: "2fa" → 发截图 + "请发送验证码"
User: "123456"
Skill: node scripts/sync-login.js kindle input "123456"
  → login_complete → "登录成功！开始同步..."
```

### 4.4 WeRead 微信读书特殊处理

微信读书使用微信扫码登录，无账号密码输入：

```
sync-login.js weread start
  → step: "wechat_qr"
  → 发截图（二维码）给用户: "请用微信扫描二维码登录"
  → 轮询 sync-login.js weread status 每 10 秒
  → loggedIn: true → 进入 Phase 2
```

---

## 5. 文件清单

| 文件 | 大小 | 用途 |
|------|------|------|
| `scripts/sync-login.js` | ~400 行 | 截图交互式登录（4 个命令） |
| `scripts/sync-books.js` | ~810 行 | 自动化书籍同步 |
| `scripts/sync-server.cjs` | ~200 行 | HTTP 接收服务 |
| `chrome-extension/` | ~8.3MB | 预打包 Chrome 扩展 |
| `.chrome-profile/` | 动态 | Chrome 用户数据（登录 session） |
| `SKILL.md` | ~250 行 | Skill 行为定义（AI 编排指令） |

---

## 6. 关键配置

### 6.1 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CASTREADER_EXT_PATH` | (无) | 自定义扩展路径 |
| `CHROME_PROFILE` | `.chrome-profile/` | Chrome 用户数据目录 |

### 6.2 端口

| 端口 | 用途 |
|------|------|
| 9224 | Chrome CDP 远程调试（sync-login.js） |
| 18790 | sync-server 文件接收 |

### 6.3 扩展查找优先级

```
1. $CASTREADER_EXT_PATH (环境变量)
2. ~/Documents/MyProject/readout-desktop/.output/chrome-mv3/ (开发构建)
3. ./chrome-extension/ (预打包，随 Skill 发布)
4. 从源码构建 (pnpm build in readout-desktop)
```

---

## 7. 已知问题与限制

| 问题 | 说明 | 状态 |
|------|------|------|
| "Kindle App Is Required" | 部分书籍无法在 Cloud Reader 打开，自动跳过 | 已处理 |
| Puppeteer `--disable-extensions` | 默认禁用扩展，需 `ignoreDefaultArgs` 排除 | 已修复 |
| Amazon `input.value` 赋值无效 | 需用 `page.type()` 触发真实键盘事件 | 已修复 |
| Landing 页重定向 | 未登录时跳转到 `/landing` 而非 `/ap/signin` | 已处理 |
| CDP 共享连接 | `browser.disconnect()` 后 targets 丢失 | 改为独立启动 |
| SW 休眠 | 扩展 SW 30s 空闲后休眠，需刷新页面唤醒 | 已处理 |
| 书名匹配 | 使用前 30 字符子串模糊匹配，极端情况可能误判 | 可接受 |

---

## 8. 测试验证记录 (2026-03-19)

### 8.1 清除 session 后完整流程测试

```
✅ Step 1: rm -rf .chrome-profile/ (清除所有登录态)
✅ Step 2: sync-login.js kindle start → 跳转到 landing → 自动点击 Sign in → 进入登录表单
✅ Step 3: sync-login.js kindle input "email" → 邮箱输入成功 → 进入密码页
✅ Step 4: sync-login.js kindle input "password" → 密码输入成功 → login_complete
✅ Step 5: sync-login.js kindle stop → Chrome 关闭
✅ Step 6: sync-books.js kindle --max 2 → 用保存的 session 自动登录
✅ Step 7: 扩展正常加载 (ignoreDefaultArgs fix)
✅ Step 8: 找到 16 本书，14 本已同步，同步 1 本新书成功
✅ Step 9: 1 本 "WHAT IF?" 无法在 Cloud Reader 打开，正确跳过
```

### 8.2 Session 持久化验证

```
✅ 删除 profile 后首次登录 → session 保存
✅ 关闭 Chrome 后重启 → 自动登录成功（无需再输账密）
✅ sync-login.js start → event: "already_logged_in"
```
