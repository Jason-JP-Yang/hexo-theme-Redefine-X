# Masonry Reactions 点赞系统 & 自托管 Giscus Client 技术文档

> **Version:** 1.0.0  
> **Date:** 2026-02-10  
> **Author:** Generated for redefine-x theme

---

## 目录

1. [系统概述](#系统概述)
2. [架构设计](#架构设计)
3. [文件清单](#文件清单)
4. [构建流程](#构建流程)
5. [自托管 Giscus Client](#自托管-giscus-client)
6. [Masonry 点赞系统](#masonry-点赞系统)
7. [配置说明](#配置说明)
8. [数据流详解](#数据流详解)
9. [GitHub API 使用策略](#github-api-使用策略)
10. [安全注意事项](#安全注意事项)
11. [已知限制](#已知限制)
12. [故障排查](#故障排查)

---

## 系统概述

本系统包含两个核心功能：

### 1. 自托管 Giscus Client
将 giscus 评论系统的客户端加载脚本从 `https://giscus.app/client.js` 迁移为本地自托管，消除对外部 CDN 的依赖。iframe widget 仍使用 giscus.app 的服务端渲染。

### 2. Masonry 图片点赞系统
基于 GitHub Discussion 评论的 HEART 反应（❤️）为瀑布流相册中的每张图片实现点赞功能。构建时预创建 Discussion 和 Comment，前端通过 GitHub GraphQL API 读取/切换反应状态。

---

## 架构设计

```
┌─────────────────────────────────────────────────────────────────┐
│                        Hexo 构建阶段                             │
│                                                                 │
│  masonry-reactions.js          masonry-generator.js             │
│  (before_generate filter)       (generator)                     │
│         │                           │                           │
│  GitHub GraphQL API ◄──── PAT ──►  读取 hexo._masonryReactions │
│  ┌─ 搜索/创建 Discussion          ┌─ 注入 reaction 数据到页面    │
│  ├─ 为每张图创建 Comment           └─ 生成 HTML 包含嵌入 JSON     │
│  ├─ 获取 HEART 反应计数                                         │
│  └─ Lock Discussion                                            │
└─────────────────────────────────────────────────────────────────┘
                              ↓ 生成 HTML
┌─────────────────────────────────────────────────────────────────┐
│                        浏览器前端                                │
│                                                                 │
│  giscus-client.js (自托管)      masonry-reactions.js            │
│  ┌─ 创建 iframe → giscus.app    ┌─ 读取嵌入 JSON 数据           │
│  ├─ 管理 session/token           ├─ 创建 ❤️ 按钮覆盖层          │
│  ├─ postMessage 通信             ├─ giscus session → token 交换  │
│  └─ CSS 内联（无外部请求）         ├─ GitHub API 获取实时数据      │
│                                  └─ 点击 → 切换 HEART reaction   │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────────────┐   │
│  │ giscus.app  │  │ GitHub API  │  │ localStorage          │   │
│  │ (iframe)    │  │ (GraphQL)   │  │ giscus-session        │   │
│  │ 评论渲染    │  │ 反应读写    │  │ masonry-reactions-*   │   │
│  └─────────────┘  └─────────────┘  └───────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 文件清单

### TypeScript 源码 (`dev/giscus/`)

| 文件 | 说明 |
|---|---|
| `client-self-hosted.ts` | 自托管 giscus client，基于官方 client.ts 修改 |
| `masonry-reactions-client.ts` | Masonry 点赞前端逻辑 |
| `tsconfig.client.json` | 客户端文件专用 TypeScript 编译配置 |
| `build-client/` | 编译输出目录（生成后存在） |

### 主题文件 (`themes/redefine-x/`)

| 文件 | 类型 | 说明 |
|---|---|---|
| `source/js/plugins/giscus-client.js` | 前端 JS (minified) | 自托管 giscus 客户端加载器 |
| `source/js/plugins/giscus-client.source.js` | 前端 JS (source) | 可读源码，调试用 |
| `source/js/plugins/masonry-reactions.js` | 前端 JS (minified) | Masonry 点赞 UI 逻辑 |
| `source/js/plugins/masonry-reactions.source.js` | 前端 JS (source) | 可读源码，调试用 |
| `scripts/masonry-reactions.js` | Hexo 构建脚本 | 构建时创建 Discussion/Comment |
| `scripts/masonry-generator.js` | Hexo 构建脚本 | 页面生成器（已修改，注入反应数据） |
| `layout/components/comments/giscus.ejs` | EJS 模板 | giscus 评论模板（已修改，使用本地脚本） |
| `layout/pages/masonry/masonry.ejs` | EJS 模板 | Masonry 页面模板（已修改，集成点赞 UI） |
| `source/css/layout/_partials/page-template.styl` | Stylus CSS | Masonry 点赞样式 |

---

## 构建流程

### 前置要求

```bash
cd dev/giscus
yarn install  # 或 npm install（需要 TypeScript 和 google-closure-compiler）
```

### 编译步骤

```bash
# 1. TypeScript 编译
npx tsc --project tsconfig.client.json

# 2. Closure Compiler 压缩
npx google-closure-compiler --js build-client/client-self-hosted.js --js_output_file build-client/client-self-hosted.min.js
npx google-closure-compiler --js build-client/masonry-reactions-client.js --js_output_file build-client/masonry-reactions-client.min.js

# 3. 复制到主题目录
$themeJs = "themes/redefine-x/source/js/plugins"
cp build-client/client-self-hosted.min.js $themeJs/giscus-client.js
cp build-client/client-self-hosted.js $themeJs/giscus-client.source.js
cp build-client/masonry-reactions-client.min.js $themeJs/masonry-reactions.js
cp build-client/masonry-reactions-client.js $themeJs/masonry-reactions.source.js
```

### 一键构建（PowerShell）

```powershell
cd dev/giscus
npx tsc --project tsconfig.client.json
npx google-closure-compiler --js build-client/client-self-hosted.js --js_output_file build-client/client-self-hosted.min.js
npx google-closure-compiler --js build-client/masonry-reactions-client.js --js_output_file build-client/masonry-reactions-client.min.js
$target = "..\..\themes\redefine-x\source\js\plugins"
Copy-Item "build-client\client-self-hosted.min.js" "$target\giscus-client.js" -Force
Copy-Item "build-client\client-self-hosted.js" "$target\giscus-client.source.js" -Force
Copy-Item "build-client\masonry-reactions-client.min.js" "$target\masonry-reactions.js" -Force
Copy-Item "build-client\masonry-reactions-client.js" "$target\masonry-reactions.source.js" -Force
Write-Host "Build & deploy complete."
```

---

## 自托管 Giscus Client

### 与官方 client.js 的区别

| 方面 | 官方 client.js | 自托管版本 |
|---|---|---|
| 脚本加载来源 | `https://giscus.app/client.js` | `/js/plugins/giscus-client.js`（本站） |
| giscus 服务器源 | 从 `script.src` 推导 | `data-giscus-origin` 属性或默认 `https://giscus.app` |
| CSS 加载方式 | 从 giscus.app 加载 `default.css` | 内联 `<style>` 标签（无外部请求） |
| widget iframe | 指向 giscus.app | 指向 giscus.app（不变） |
| 配置 API | 无 | 暴露 `window.__giscus.setConfig()` |

### 配置

在 `giscus.ejs` 模板中，脚本通过以下方式加载：

```html
<script src="/js/plugins/giscus-client.js"
        data-giscus-origin="https://giscus.app"
        data-repo="..."
        data-repo-id="..."
        ...>
</script>
```

如果你自行部署了 giscus 服务端（如在 Vercel 上），修改 `data-giscus-origin` 即可：

```html
data-giscus-origin="https://your-giscus-instance.vercel.app"
```

### 内联 CSS

自托管版本将 giscus default.css 内联为：

```css
.giscus,.giscus-frame{width:100%;min-height:150px}
.giscus-frame{border:none;color-scheme:light dark}
.giscus-frame--loading{opacity:0}
```

无需额外加载任何外部 CSS。

---

## Masonry 点赞系统

### 工作原理

#### 构建阶段 (`scripts/masonry-reactions.js`)

1. **搜索 Discussion**：通过 GitHub Search API 查找标题为 `[masonry-reactions] masonry/页面名/` 的 Discussion
2. **创建 Discussion**：若不存在，使用 PAT 创建新 Discussion，分类使用 `_config.redefine-x.yml` 中配置的 `category_id`
3. **创建 Comment**：为每张图片创建一条评论，格式为：
   ```
   <!-- masonry-image-id: 图片路径 -->
   📷 **图片标题**
   ```
4. **Lock Discussion**：锁定 Discussion，防止用户添加新评论（但仍可添加 Reaction）
5. **获取计数**：读取每条评论的 HEART reaction 总数
6. **存储数据**：结果存入 `hexo._masonryReactions` 供页面生成器使用

#### 页面生成 (`scripts/masonry-generator.js`)

从 `hexo._masonryReactions` 读取数据，注入到 masonry 页面的 `page.masonryReactions` 中：

```javascript
{
  repo: "Jason-JP-Yang/Blog",
  repoId: "R_kgDOQyjq3A",
  categoryId: "DIC_kwDOQyjq3M4C0fjU",
  discussionTerm: "[masonry-reactions] masonry/页面名/",
  discussionNumber: 42,
  imageReactions: {
    "图片路径1": { commentId: "DC_kwDO...", heartCount: 5 },
    "图片路径2": { commentId: "DC_kwDO...", heartCount: 12 },
  }
}
```

#### 前端 (`source/js/plugins/masonry-reactions.js`)

1. **读取嵌入数据**：从 `<script type="application/json" id="masonry-reactions-data">` 获取构建时嵌入的 JSON
2. **创建 UI**：在每个 `.image-container` 上添加 ❤️ 按钮
3. **认证检查**：
   - 从 `localStorage` 读取 `giscus-session`
   - 通过 `giscus.app/api/oauth/token` 交换为 GitHub token
   - 支持 OAuth 回调竞争条件的重试机制
4. **实时数据**：使用 token 调用 GitHub GraphQL API 获取 `viewerHasReacted` + 最新计数
5. **交互**：点击 ❤️ → 调用 GitHub `addReaction` / `removeReaction` mutation

### Reactions 模式下的 UI 变化

当 `page.masonryReactions` 存在时（即 giscus 评论启用 + PAT 配置正确）：

- **图片标题**：始终显示在**左上角**（hover 时显示）
- **图片描述**：**隐藏**（不显示 description）
- **❤️ 按钮**：显示在**右下角**（hover 时显示；有计数时常显）
- **底部评论区**：正常 giscus 评论仍在底部显示

未启用 reactions 时，masonry 页面行为与原来完全一致。

---

## 配置说明

### `_config.redefine-x.yml` 必需配置

```yaml
comment:
  enable: true
  system: giscus
  config:
    giscus:
      repo: Your-Username/Your-Repo           # GitHub 仓库
      repo_id: R_kgDO...                       # 仓库 ID
      category: General                        # Discussion 分类名
      category_id: DIC_kwDO...                 # 分类 ID
      mapping: pathname                        # 页面映射方式
      # ...其他 giscus 标准配置...
      
      # Masonry Reactions 专用配置
      # 需要 GitHub PAT，具有 repo discussions read/write 权限
      author_pat: github_pat_xxxxx
```

### PAT 权限要求

GitHub Personal Access Token 需要以下权限：
- `repo` → `discussions` → **Read and Write**
- 用于创建 Discussion、添加 Comment、锁定 Discussion

### 启用/禁用

- **启用条件**：`comment.enable: true` + `comment.system: giscus` + `author_pat` 已配置
- **禁用**：移除 `author_pat` 或设置 `comment.enable: false`，masonry 页面自动回退到原始模式

---

## 数据流详解

```
masonry.yml (图片数据)
    ↓
masonry-reactions.js (before_generate)
    ├── GitHub Search API → 查找已有 Discussion
    ├── GitHub mutations → 创建 Discussion/Comment/Lock
    ├── 获取 HEART reaction 计数
    └── hexo._masonryReactions = { ... }
    ↓
masonry-generator.js (generator)
    ├── 读取 hexo._masonryReactions
    ├── 注入 page.masonryReactions
    └── 生成 HTML
    ↓
masonry.ejs (模板)
    ├── 渲染 .masonry-reactions-mode 容器
    ├── 嵌入 <script type="application/json">
    └── 引用 masonry-reactions.js
    ↓
浏览器加载
    ├── masonry-reactions.js 读取嵌入 JSON
    ├── 创建 ❤️ 按钮 (构建时计数)
    ├── 尝试 giscus OAuth token 交换
    ├── GitHub GraphQL → 获取实时 viewerHasReacted
    └── 用户点击 → mutation toggle reaction
```

---

## GitHub API 使用策略

### 最小化 API 调用

| 阶段 | API 调用 | 触发条件 |
|---|---|---|
| 构建时 | 1× Search + N× CreateComment | 仅新图片需要 CreateComment |
| 构建时 | 1× Lock | 仅未锁定时 |
| 前端 | 1× OAuth token exchange | 每次页面加载（有 session 时） |
| 前端 | 1× GraphQL query (100 comments) | 每次页面加载（已认证时） |
| 前端 | 1× Mutation per click | 用户交互时 |

### 避免 Rate Limit 的设计

1. **构建时批量处理**：使用 PAT（5000 req/hr）而非用户 token
2. **增量处理**：只为新增图片创建 Comment，已有的跳过
3. **预嵌入数据**：构建时获取的计数嵌入 HTML，未登录用户零 API 调用
4. **Discussion 锁定**：防止意外 Comment，减少数据膨胀
5. **每次操作 200ms 间隔**：构建时创建 Comment 间加入延迟

---

## 安全注意事项

### PAT 保护

`author_pat` 是 GitHub 个人访问令牌，**不应提交到公开仓库**。建议：

1. 将 `_config.redefine-x.yml` 添加到 `.gitignore`
2. 或使用环境变量替代：
   ```javascript
   // 在 masonry-reactions.js 中
   const pat = process.env.MASONRY_REACTIONS_PAT || giscusConfig.author_pat;
   ```

### 前端 Token 安全

- 前端使用的 token 来自 giscus OAuth 流程，是用户级别的 token
- 该 token 仅用于 GitHub GraphQL API 的 HEART reaction 操作
- token 不会暴露给其他页面或第三方

### XSS 防护

嵌入的 JSON 数据使用 `\u003c` 转义 `<` 字符，防止 `</script>` 注入：

```ejs
<%- JSON.stringify(page.masonryReactions).replace(/</g, '\\u003c') %>
```

---

## 已知限制

### 1. 100 张图片上限

单个 masonry 页面最多支持 100 张图片的点赞追踪。原因：GitHub GraphQL `comments(first: 100)` 限制。超过 100 张图片需要实现分页查询。

### 2. 首次 OAuth 登录时的竞争条件

如用户从 masonry 页面首次 OAuth 登录：
- `giscus-client.js` 和 `masonry-reactions.js` 可能存在执行时序差异
- 系统已实现 2 秒重试机制 + `storage` 事件监听来处理此问题
- 最坏情况下用户需要刷新一次页面

### 3. GitHub Search API 最终一致性

新创建的 Discussion 可能需要数秒才能被 Search API 索引。如果在创建后立即重新构建，可能会重复创建。建议构建间隔 > 1 分钟。

### 4. 评论系统依赖

点赞系统依赖 giscus 评论系统启用。如果关闭评论（`comment.enable: false`），点赞功能也会关闭。

---

## 故障排查

### 构建时没有创建 Discussion

**检查：**
- `_config.redefine-x.yml` 中 `author_pat` 是否正确
- PAT 是否有 `repo:discussions` 权限
- `repo`、`repo_id`、`category_id` 是否正确
- 运行 `hexo generate` 查看日志中的 `[masonry-reactions]` 前缀消息

### 点赞按钮不显示

**检查：**
- 页面 HTML 源码中是否存在 `<script type="application/json" id="masonry-reactions-data">`
- 该 JSON 中 `imageReactions` 是否为空对象
- 浏览器 Console 中是否有 `[masonry-reactions]` 错误日志

### 点赞按钮灰色/不可点击

**原因：** 用户未通过 giscus OAuth 登录
**解决：** 在页面底部的 giscus 评论区进行 GitHub 登录，登录后刷新页面

### OAuth 回调后点赞仍不可用

**原因：** 首次登录的竞争条件
**解决：** 刷新页面即可，后续访问不会再出现此问题

### 点赞数与实际不符

**原因：** 构建时获取的是快照数据，前端会获取实时数据覆盖
**注意：** 仅已登录用户会看到实时数据；未登录用户看到的是构建时的快照

### giscus 评论不加载

**检查：**
- 浏览器 Network 面板确认 `/js/plugins/giscus-client.js` 成功加载
- 确认 `https://giscus.app` 可访问（iframe widget 服务端）
- Console 中查看 `[giscus]` 前缀的错误消息

---

## 变更记录

| 日期 | 版本 | 说明 |
|---|---|---|
| 2026-02-10 | 1.0.0 | 初始实现：自托管 giscus client + masonry 点赞系统 |
