# Diff Wingman

本地源码导读工作台。比较 Git 提交、暂存区或当前工作区，将真实 diff、需求原文、Codex 导读和人工审查记录放在同一个界面中。

后续版本方向见 [开发路线图](docs/roadmap.md)。路线图中的功能均为规划，只有写入对应版本范围与验收记录后才视为已经实现。

## 启动

需要 Node.js 20.19+、pnpm、Git。macOS 系统文件夹弹窗使用系统自带的 `osascript` 和 AppKit。AI 功能还需要官方 Codex CLI（本项目验证版本为 0.144.1）及 ChatGPT 登录。

```bash
pnpm install
pnpm dev
```

打开终端显示的本地地址，默认 http://127.0.0.1:4318。

生产构建：

```bash
pnpm build
pnpm start
```

`REVIEW_HELPER_PORT` 可指定端口（1024–65535）；`REVIEW_HELPER_DATA_DIR` 可指定本地数据目录。默认数据在项目 `.review-helper/`，被 Git 忽略。

### macOS 桌面应用

桌面版复用同一套页面和本机接口，双击应用后会自行启动服务并打开窗口；“选择文件夹”直接使用 Electron 的系统目录弹窗。构建桌面版需要 Node.js 22.12+（22.x）、pnpm 和 Git：

```bash
pnpm install
pnpm desktop:dev       # 从源码启动桌面窗口
pnpm desktop:package   # 生成 out/ 中的 .app
pnpm desktop:make      # 生成 out/make/ 中的 macOS ZIP
```

从源码运行桌面版时，记录仍使用项目 `.review-helper/`；打包后默认写入 `~/Library/Application Support/Diff Wingman/reviews/`，不会随应用更新被覆盖。首次从旧版启动时，会复制 `~/Library/Application Support/Source Review Helper/reviews/` 中的已有记录并保留原目录。如需沿用网页版已有记录，退出应用后将原 `.review-helper/` 内的 JSON 文件复制到新目录，或启动前设置 `REVIEW_HELPER_DATA_DIR` 指向原目录。桌面版使用随机本机端口，不占用网页版的 4318 端口。Git、Codex CLI 与 Docker 仍需安装在本机；私有 GitLab MR 仍使用现有环境变量配置。当前生成的应用没有签名或公证，只用于本机验收。

## 使用

1. 在 macOS 点击“选择文件夹”打开系统目录弹窗，或手动输入本地 Git 仓库的绝对路径；再选择“两个提交版本”“HEAD → 暂存区”或“HEAD → 当前工作区”。两个提交版本可从本地分支、远端跟踪分支、标签和 HEAD 中选择，也可手动输入引用或 commit；列表只读本地已有版本，不自动 fetch。提交前模式需要仓库已有 `HEAD`。
2. 工作区模式自动包含已跟踪文件的修改；点击“选择未跟踪文件”后，逐项勾选需要纳入的文件。
3. 可填写“本次需求”和“不得改变项”，每行一项。点击“打开变更”固定此刻源码和需求；此时不调用模型。
4. 查看文件 diff，或点击“生成阅读路线”，通过 Codex 生成业务分组、需求对照与有证据的流程步骤。
5. 点击源码引用，围绕分组追问，并由人工保存笔记和审查状态；“已核实”需要填写核实依据。
6. “最近快照”可重新打开记录。提交前源码变化会提示快照过期；从左侧重新建立当前快照后再核实。
7. 第三版可对需求、修改前后、关键规则和流程中的每条判断单独记录“已确认、有疑问、不成立”及人工依据；点击“导出审查报告（Markdown）”保存需求、源码位置与人工记录。
8. 打开第二版保存过的同一源码快照后，再点击“打开变更”，可补充第三版的静态引用；原有导读、笔记和人工状态仍保留。
9. 第四版在两个 commit 的快照中列出待核对判断。选择目标 commit 中的检查脚本，填写触发条件和预期结果，再点击“运行选定检查”；退出码和日志会保存在本地报告中，人工状态不会自动改变。
10. 第五版可将“来源”切换到“GitLab MR（只读）”，填写本地仓库与 MR 链接。导入成功后可在 diff 新增/删除行创建本地评论草稿，复制或导出；MR 版本变化后旧草稿标为待重核。

首次使用 AI 前在终端执行 `codex login`，再以 `codex login status` 确认 ChatGPT 登录。工具不读取或复制 auth.json，当前版本仅允许 ChatGPT 登录；不会在订阅额度不足时自动切换 API Key。

读取私有 GitLab MR 时，在启动工具前设置 `REVIEW_HELPER_GITLAB_TOKEN` 和 `REVIEW_HELPER_GITLAB_HOST`（只填域名，例如 `gitlab.example.com`）。请使用具备读取 MR 权限的令牌；第五版仅发 GET 请求，不会在 GitLab 上发布评论或修改 MR。导入所需 commit 必须已在本地仓库中，工具不会自动 fetch。完整边界见 [第五版范围与契约](docs/v5-scope.md)。

## 当前边界

- **版本**：手工提交比较仍使用两个 commit 的端点；GitLab MR 模式使用平台给出的 merge-base 和 head，并核对 diff 版本。提交前模式以当时的 `HEAD` 为基线；工作区包括已跟踪文件的暂存和未暂存修改，未跟踪文件仅纳入明确勾选的项。工具不会 checkout、修改 index 或写入被审查仓库。
- **源码**：支持 UTF-8 文本；二进制、符号链接、子模块、超过 256 KB 的单个文件保留记录并明确标为未分析。快照文本最多 8 MB、300 个变更文件。
- **上下文**：JS/TS/JSX 解析变更所在函数，补充每侧最多 10 个相关文件。对已载入的固定快照文本，TypeScript Language Service 最多检查每侧 6 个变更声明、30 处跨文件静态引用；超出 60 文件或 150 万字符时保留原有候选。未完整载入的模块、别名路径、动态调用与运行时注入仍待人工核对，静态引用不证明运行时可达。
- **模型**：通过官方 `codex exec` 调用；以空临时目录为工作目录，关闭命令执行、插件、hooks、应用、浏览器等不需要的能力，使用只读沙箱。提示词与固定源码通过 stdin 传入。导读单批上下文最多 180,000 字符，超限时按文件顺序分批并合并校验；单批 8 分钟超时，同一时间仅执行一个任务，支持取消。
- **数据**：本地读取不等于离线推理。点击生成/追问会将选定的源码上下文及输入的需求发往 Codex 服务，并消耗该账号权益。源码快照、导读、人工状态和笔记保存在本机，报告在本地生成；临时模型输入输出在调用结束后清理。
- **解释**：校验结果结构、引用 ID、需求 ID 与每处变更的归属。需求对照和业务步骤仍是待人工核实的解释；静态符号引用也不证明运行时调用关系。第四版只在用户选择后运行检查脚本，不自动批准或修复。
- **隔离验证**：需要运行中的 Docker 和本机已有的 `node:22-alpine` 镜像，或通过 `REVIEW_HELPER_VERIFY_IMAGE` 指定的本机镜像。只支持 commit 快照、根目录 `package.json` 中的检查脚本；不会拉取镜像、安装依赖或在宿主机回退执行。源码由 Git 对象还原到工具临时目录，容器无网络、源码只读，资源和输出受限。详细限制见 `docs/v4-scope.md`。
- **持久化**：提交前快照按源码及需求内容固定身份；笔记和人工状态只属于对应快照。逐条判断绑定整份导读，导读或源码变化后旧记录在页面和报告中标为待重核。只面向个人本地使用，无公共服务器或多用户认证。
- **MR 评论**：仅支持 GitLab MR 只读导入与本地草稿。链接必须匹配本地 Git 远端；平台 diff 与本地快照不一致、被折叠或超限时拒绝导入。MR 更新后旧草稿不会自动迁移；复制前再次检查版本。不会向平台写入评论、批准或合并。

官方参考：[Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[认证方式](https://developers.openai.com/codex/auth)。

## 代码阅读路线

1. `src/shared/types.ts`、`schemas.ts`：快照、证据与模型输出契约。
2. `src/server/git.ts`：读取 Git 对象、提取变更和静态上下文。
3. `src/server/guide.ts`：准备输入及校验引用、覆盖。
4. `src/server/symbols.ts`：在固定快照的有限文本中查找 JS/TS 静态符号引用。
5. `src/server/codex.ts`：官方 CLI 调用、订阅检查、取消和失败处理。
6. `src/server/store.ts`、`report.ts`：本地记录与 Markdown 报告。
7. `src/server/app.ts`：本机接口、任务生命周期与存储连接。
8. `src/web/App.tsx`、`CodePanel.tsx`：导读、diff、引用跳转与笔记。
9. `src/server/verification.ts`：第四版 commit 还原、脚本选择与隔离执行。
10. `src/server/gitlab.ts`：第五版只读 MR 导入、diff 行定位与版本新鲜度检查。

## 定向验证

```bash
pnpm check:git
pnpm check:guide
pnpm check:server
pnpm check:v2
pnpm check:v3
pnpm check:v4
pnpm check:v5
pnpm build
```

Docker Desktop 运行且本机已有验证镜像时，可额外执行 `pnpm check:v4:docker`，用临时合成仓库检查真实容器的固定 commit、只读源码、无网络和证据落盘。

HTTP 测试使用可控的模型适配器，验证真实快照、接口、持久化和任务生命周期；不证明真实 Codex 服务可用。真实 CLI 验证另行记录在 `docs/verification.md`。

第五版的 GitLab 只读导入、草稿及过期路径使用合成 MR 验收，结果见 [第五版验收记录](docs/v5-verification.md)；真实私有 MR 仍需提供可读链接和授权后验证。

生成用于手动验证的最小临时 Git 仓库：

```bash
pnpm exec tsx scripts/create-demo.ts
```

脚本输出路径与两个 commit。该仓库只包含合成示例，不涉及业务仓库。
