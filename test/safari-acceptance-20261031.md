# Safari / Poe 真实验收（2026-10-31）

## 环境与实际发现

- 使用本机 Safari、Userscripts 4.8.6 (136)、已安装的脚本 1.2.1。安装文件与本任务分支源文件完全一致。
- 初查真实 Poe 页面：面板只有旧版设置，没有“固定阅读位置”开关及脚本的“回到底部”按钮。文件已更新，页面实际运行的脚本尚未更新。
- 打开 Userscripts 应用核对 `Save Location`，在 Safari 扩展弹窗重新扫描，再重新载入 Poe 页面后，面板出现并开启“固定阅读位置”，状态显示“已固定，可手动滚动”。
- 随后通过 Safari 自身“显示 > 重新载入页面”再次加载，阅读保护仍会自动开启。
- 本轮没有修改滚动代码或再次升版，没有提交、合并或推送。

## 真实测试

在独立的 [浏览器滚动验收测试聊天](https://poe.com/chat/ahyt15nl09j12e6weq) 中进行。测试内容是编号的公园景物段落，不包含原聊天正文。

1. 第一轮生成第 01～12 段，形成已有聊天记录。
2. 第二轮生成第 13～52 段。在仍显示“停止信息”的生成期间，用真实 Safari 的滚动操作先到底部，再向上滚动。截图中顶部阅读位置停在第 33 段；回复生成完第 52 段后，仍停在同一位置。
3. 使用 Safari 自身命令重新载入页面，确认阅读保护自动开启。
4. 第三轮生成第 53～84 段，连续三次执行“到底部 → 向上滚动 → 停止输入并观察”。每一组前后截图均确认回复仍在生成，保护开关开启。
5. 回复完成后再连续向上滚动两次，首个完整可见段落从第 71 段移至第 68 段，向上阅读可用。

| 生成期间的重复操作 | 第一帧末段 | 第二帧末段 | 两帧均在生成 | 阅读文字区域像素差异 |
| --- | --- | --- | --- | --- |
| 重载后第 1 次 | 80 | 81 | 是 | 0 |
| 重载后第 2 次 | 81 | 81 | 是 | 0 |
| 重载后第 3 次 | 82 | 82 | 是 | 0 |

## 截图核对方法

原始截图均为 2732 × 1998 像素。对比矩形从 `(690, 310)` 到 `(1900, 850)`，覆盖屏幕上方已完成的阅读段落。使用 macOS 自带 `sips` 解码为位图，通过 Python 标准库读取像素进行比较；未安装图像处理依赖。

第二轮生成中与生成完成后的对照，以及重载后的三组对照，这一区域全部像素均完全一致。这个结果只针对上述实际观察到的场景和区域。

## 原始证据

- [第二轮生成中，向上滚动后的原图](/Users/mac/.codex/visualizations/2026/10/30/01a18d2c-419e-7c81-aa57-5ac40346a040/safari-live-acceptance-20261031-01.jpg)
- [第二轮生成结束，阅读位置保持的原图](/Users/mac/.codex/visualizations/2026/10/30/01a18d2c-419e-7c81-aa57-5ac40346a040/safari-live-acceptance-20261031-02.jpg)
- 重载后第 1 次：[上滚后](/Users/mac/.codex/visualizations/2026/10/30/01a18d2c-419e-7c81-aa57-5ac40346a040/safari-live-acceptance-20261031-reload-1-a.jpg) · [继续生成后](/Users/mac/.codex/visualizations/2026/10/30/01a18d2c-419e-7c81-aa57-5ac40346a040/safari-live-acceptance-20261031-reload-1-b.jpg)
- 重载后第 2 次：[上滚后](/Users/mac/.codex/visualizations/2026/10/30/01a18d2c-419e-7c81-aa57-5ac40346a040/safari-live-acceptance-20261031-reload-2-a.jpg) · [继续生成后](/Users/mac/.codex/visualizations/2026/10/30/01a18d2c-419e-7c81-aa57-5ac40346a040/safari-live-acceptance-20261031-reload-2-b.jpg)
- 重载后第 3 次：[上滚后](/Users/mac/.codex/visualizations/2026/10/30/01a18d2c-419e-7c81-aa57-5ac40346a040/safari-live-acceptance-20261031-reload-3-a.jpg) · [继续生成后](/Users/mac/.codex/visualizations/2026/10/30/01a18d2c-419e-7c81-aa57-5ac40346a040/safari-live-acceptance-20261031-reload-3-b.jpg)
- [第三轮完成后的原图](/Users/mac/.codex/visualizations/2026/10/30/01a18d2c-419e-7c81-aa57-5ac40346a040/safari-live-acceptance-20261031-reload-final.jpg)
- 连续向上滚动：[第 1 次](/Users/mac/.codex/visualizations/2026/10/30/01a18d2c-419e-7c81-aa57-5ac40346a040/safari-live-acceptance-20261031-continuous-up-1.jpg) · [第 2 次](/Users/mac/.codex/visualizations/2026/10/30/01a18d2c-419e-7c81-aa57-5ac40346a040/safari-live-acceptance-20261031-continuous-up-2.jpg)
- [生成状态与时间采样](/Users/mac/.codex/visualizations/2026/10/30/01a18d2c-419e-7c81-aa57-5ac40346a040/safari-live-acceptance-20261031-reload-cycles.json)
- [像素对比结果](/Users/mac/.codex/visualizations/2026/10/30/01a18d2c-419e-7c81-aa57-5ac40346a040/safari-live-acceptance-20261031-comparison.json)
