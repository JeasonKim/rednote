## 职责

汇总文案和配图，基于可复用模板与渲染脚本生成一个可直接在浏览器打开的仿小红书预览页面。实例页面应由结构化数据灌入脚本生成，避免靠模型推理拼接 HTML。

## 输入与参考

- `copywriting` 节点的 `outputs/note-copy.md`。
- `visual_generation` 节点的 `outputs/images/`。
- `visual_generation` 节点的 `outputs/visual-summary.md`。
- workflow 层 `Context/account-positioning.md`。
- 当前节点 workflow 层 `Context/xhs-preview-template.html` 和 `Context/render-xhs-preview.mjs`；如果 Context 中不存在这些文件，本节点可先在 `outputs/` 中生成同等文件供本次使用。

## 执行步骤

// 整理预览数据

将本篇推荐标题、正文、标签、评论区引导和图片列表整理成 `outputs/preview-data.json`。图片路径必须相对最终 HTML 文件可访问，图片顺序必须与配图节点编号一致。

// 使用脚本渲染实例页面

优先使用 `Context/render-xhs-preview.mjs` 读取 `outputs/preview-data.json` 和 `Context/xhs-preview-template.html`，渲染生成 `outputs/xhs-preview.html`。脚本应只负责数据校验、模板数据块替换和文件输出，不重新创作文案或改写图片内容。

// 必要时生成可复用预览模板

如果 workflow Context 中尚未提供模板和脚本，本节点需要创建 `outputs/xhs-preview-template.html` 与 `outputs/render-xhs-preview.mjs`，模板应仿造小红书笔记预览体验，包含图片轮播区域、标题、正文、标签、操作区和一键复制文案能力。

// 提供发布前复制能力

预览页面必须支持一键复制文案。复制内容应包含推荐标题、正文、标签和评论区引导，不能混入模板说明、调试信息或图片路径。

## 页面要求

- 页面可以通过浏览器直接打开，不依赖后端服务。
- 页面布局优先适配手机预览，也应在桌面浏览器中居中显示。
- 图片按编号顺序展示。
- 文案复制按钮有明确状态反馈，例如复制成功或失败提示。
- 脚本遇到数据缺失、模板标记缺失或复制降级失败时必须输出 `console.warn` 或进程错误信息，不允许静默失败。

## 边界

本节点不重新创作文案，不重新生成图片，不发布到小红书。