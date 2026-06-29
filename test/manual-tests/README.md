# Hash-Anchored Edit — 手动测试场景

本目录包含 13 个手动测试场景，用于验证 pi-hashline 的 read/edit 工具
在收到自然语言提示词后，能否返回正确的指令并正确修改文件。

## 如何使用

1. 打开任意场景的 `prompt.md` 文件，拷贝其中的"提示词"
2. 将提示词发送给 AI（本助手）
3. AI 会先 `read` 源文件获取 LINE#HASH 锚点
4. AI 根据锚点构造 `edit` 指令，修改文件
5. 对比修改后的文件与 `expected.xxx`，两者应完全一致

## 场景列表

| # | 场景 | 操作类型 | 涉及特性 |
|---|------|---------|---------|
| 01 | 重命名变量 | patch | read + patch |
| 02 | 修改配置项 | replace 整行 | read + replace |
| 03 | 在字段后插入 | after | read + after |
| 04 | 删除方法行 | delete | read + delete |
| 05 | 一次修改多个字段 | 多个 patch | read + 多编辑一次调用 |
| 06 | CRLF 文件拼写修正 | patch | read + CRLF 保留 |
| 07 | 文件顶部插入 | before | read + before |
| 08 | 多行替换 | replace 多行 | read + multi-line replace |
| 09 | Hash 不匹配后重试 | patch 重试 | 失败 → re-read → 重试 |
| 10 | 分页读取后编辑 | patch | offset+limit read → edit |
| 11 | Dry-run 预览 | patch | dryRun → 确认 → edit |
| 12 | 编辑后重新读取 | patch + re-read | read → edit → read |
| 13 | 混合换行符 | patch | read + 混合 EOL 检测 |

## 一键验证

也可以用以下命令自动验证所有场景：

```bash
npx tsx test/manual-tests/auto-verify.ts
```
