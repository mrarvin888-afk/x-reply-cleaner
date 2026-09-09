# Twitter Reply Cleaner

> 一个本地浏览器扩展,**批量删除你在 X / Twitter 上发过的回复**。原创帖和转推不会被删。

## 它能做什么

- 自动滚动并逐条删除你账号下所有"回复了别人的推"(含纯文本、图片、视频回复)。
- 保留:你的原创帖、转推、点赞、书签、个人资料、关注列表 — 全部不动。
- 速度可选(1.5s / 2.0s / 2.5s / 3.5s 每条),带随机抖动,降低被风控识别的概率。
- 全程在本机浏览器内执行,无第三方服务器、无数据上传、无追踪。

## 它不能做什么

- 不能删除**别人的推** — 只删你自己账号的回复。
- 不能批量撤销 — 删除是不可恢复的(但 Twitter 自带 30 秒的 "Undo" toast 可以救一下)。
- 不能绕过 X 的验证码或限流 — 遇到时需要你手动完成验证后再启动。

## 安装

> **不要**通过 Chrome Web Store 安装。这个扩展只在本地使用,本仓库就是发布包。

1. 下载本仓库的 `twitter-reply-cleaner.zip` (或 `git clone` 后用 `manifest.json` 所在目录)。
2. 打开 Chrome / Edge / Brave 任意基于 Chromium 的浏览器,进入 `chrome://extensions`。
3. 右上角打开 **"开发者模式"**。
4. 点击 **"加载已解压的扩展程序"**,选择 `twitter-reply-cleaner` 整个文件夹(里面要有 `manifest.json`)。
5. 安装成功后,工具栏上会出现一个 🧹 图标。

## 使用步骤

1. 在浏览器中打开 `https://x.com`,**确保已登录**。
2. 点击工具栏的 🧹 图标,弹出扩展面板。
3. 点 **"📍 定位当前页面"** — 扩展会找到你打开的 X 标签页。
4. 填写你的 X 用户名(不含 `@`,例如 `elonmusk`)。扩展会尝试自动填上。
5. 选择速度(推荐 2.0s)。
6. 在确认框中输入 **`DELETE`**(大写)以确认。
7. 点 **"▶ 开始删除"**。
8. 扩展会自动:
   - 跳转到 `x.com/{username}/with_replies`
   - 识别每条"Replying to …"的回复
   - 打开三点菜单 → 删除 → 确认
   - 滚到下一页,继续
9. 面板上会实时显示已删除数量、当前正在处理的内容预览。
10. 完成后会显示 ✅。中途可以 **暂停 / 继续 / 停止**。

## 风险与注意事项

| 风险 | 说明 | 缓解 |
|---|---|---|
| **删除不可逆** | 一旦删除,推文及其所有互动消失 | 删除前 Twitter 会有 30 秒 "Undo" 提示;小号先试一次 |
| **X 风控/限流** | 短时间内大量操作可能触发验证码或临时限流 | 用"推荐"或"保守"速度;遇到验证码手动完成后再次启动 |
| **账号被封** | 极端情况(几千条 + 激进速度)可能被 X 标记异常 | 不要用 1.5s 速度批量删几千条;分批、慢速 |
| **页面结构变化** | X 偶尔改前端,选择器可能失效 | 连续多次失败会自动停止,不会无限循环 |
| **隐私** | 扩展只注入 x.com,不发任何数据到外部 | 可在 `chrome://extensions` 查看权限 |

## 文件结构

```
twitter-reply-cleaner/
├── manifest.json      # MV3 配置
├── background.js      # 消息路由 + 状态聚合
├── content.js         # 核心:DOM 自动化删除
├── popup.html         # 面板界面
├── popup.css
├── popup.js           # 面板逻辑
├── icons/             # 16/48/128 PNG
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
│   └── make-icons.ps1 # 重新生成图标的脚本
└── README.md
```

## 工作原理 (技术细节)

1. **popup** 接收用户输入,通过 `chrome.runtime.sendMessage` 把命令发给 **background service worker**。
2. **background** 用 `chrome.tabs.sendMessage` 转发给 X 页面上的 **content script**。
3. **content script** 通过 DOM 自动化:
   - 跳转到 `/{username}/with_replies` 页
   - 找到所有 `article[data-testid="tweet"]`,筛选出含 `data-testid="socialContext"` 且文本以 "Replying to" 开头的文章
   - 对每条点 `[data-testid="caret"]` → 菜单里的 "Delete" → `[data-testid="confirmationSheetConfirm"]`
   - 滚到下一页继续
4. 实时通过 `chrome.runtime.sendMessage` 上报进度,popup 轮询展示。

如果 X 改了选择器,扩展会自动停止(连续 5 次失败后),不会卡住。报错会显示在面板上,方便排查。

## 开发

- 修改 `content.js` 后,到 `chrome://extensions` 点 🔄 重新加载扩展,然后在 X 页面上点刷新。
- 调试:在 X 页面打开 DevTools → Console,可看到 `[ReplyCleaner]` 开头的日志。
- 重新生成图标:在 `icons/` 目录运行 `pwsh -File make-icons.ps1` (Windows) 或手动替换 PNG。

## 许可

MIT — 自己用,随便改。不要拿去卖。
