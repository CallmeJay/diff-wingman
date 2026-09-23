# 第五版验收记录

2026-09-22，在临时合成 Git 仓库和可控 GitLab 只读响应上完成第五版验证。

- `pnpm check:v5`：2 项定向测试通过。覆盖新增/删除行锚点、MR 远端不匹配、折叠 diff、文件列表错配、本地缺失提交、有效导入、草稿创建/编辑/删除/重导入保留、同一版本锚点变化拒绝覆盖、无效行拒绝、版本变化后拒绝保存及导出标记待重核。模拟平台请求均为 GET，被审查仓库状态不变。
- `node --import tsx --test tests/server.test.ts tests/v2-server.test.ts tests/v3-report.test.ts tests/v4-verification.test.ts`：8 项旧版相关回归通过。
- `pnpm build`：TypeScript、网页与服务端构建通过。
- 浏览器使用另一份临时合成 MR 服务核对了导入表单、固定快照、评论草稿保存、Markdown 导出预览、刷新后从历史记录恢复草稿。正式第五版页面在 `http://127.0.0.1:4318/` 可打开；临时服务与仓库已清理。

本次未连接真实私有 GitLab MR，也未验证其权限、证书或实例版本；用户未提供 MR 链接与读取令牌。Docker 的真实容器执行已在第四版单独验收，本次没有重跑。第五版未向 GitLab 写入任何内容。
