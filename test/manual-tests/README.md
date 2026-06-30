# pi-hashline — 手动测试场景

本目录包含 13 个手动测试场景，用于验证 pi-hashline 的 `read`/`edit` 工具在收到自然语言提示词后，能否返回正确的指令并正确修改文件。

所有场景都使用当前的 hashline DSL：`read` 返回 `[path#TAG]` + `N:content` 行，`edit` 接收 `[path#TAG]` 头 + `SWAP`/`DEL`/`INS.*` 操作 + `+TEXT` 正文行。

## 如何使用（手动）

1. 打开任意场景目录下的 `prompt.md`，拷贝其中的"提示词"
2. 将提示词发送给运行了 pi-hashline 扩展的 AI 助手
3. AI 先 `read` 源文件，得到 `[path#TAG]` 头和带行号的 `N:content` 行
4. AI 据此构造 `edit` 的 hashline diff 文本，修改文件
5. 对比修改后的文件与 `expected.*`，两者应完全一致

## 场景列表

| # | 场景 | hashline 操作 | 涉及特性 |
|---|------|--------------|---------|
| 01 | 重命名变量 | `SWAP` | read + 单行替换 |
| 02 | 修改配置项 | `SWAP` | read + JSON 单行替换 |
| 03 | 在字段后插入 | `INS.POST` | read + 行后插入 |
| 04 | 删除方法行 | `DEL` | read + 单行删除 |
| 05 | 一次修改多个字段 | 多个 `SWAP` | read + 同一 diff 内多 hunk |
| 06 | CRLF 文件拼写修正 | `SWAP` | read + CRLF 行尾保留 |
| 07 | 文件顶部插入 | `INS.PRE` | read + 行前插入 |
| 08 | 多行替换 | `SWAP`（1 行换多行） | read + 多行正文 |
| 09 | Hash 不匹配后重试 | `SWAP` | 失败 → re-read → 重试 |
| 10 | 分页读取后编辑 | `SWAP` | offset/limit read → edit |
| 11 | JSX 行替换 | `SWAP` | read + tsx 单行替换 |
| 12 | 编辑后重新读取 | `SWAP` | read → edit → read 闭环 |
| 13 | 混合换行符 | `SWAP` | read + 混合 EOL 检测/保留 |

> 注：本目录历史上曾使用过 `op=patch/replace/after/before/delete` 的 JSON 参数 API 和 `LINE#HASH` 锚点格式，以及一个 `dryRun` 预览参数。这些都已废弃；当前实现只支持上面的 hashline 文本 DSL，且没有 `dryRun`（编辑前预览由 pi TUI 的 diff 渲染提供）。

## 一键验证

所有场景由 `test/auto-verify.test.ts` 驱动，随单元测试一起运行：

```bash
npm test
```

或只跑这一组：

```bash
node --import @mariozechner/jiti/register --test test/auto-verify.test.ts
```

> 旧文档里提到的 `npx tsx test/manual-tests/auto-verify.ts` 路径已失效——真实的验证脚本是 `test/auto-verify.test.ts`，通过上面的命令运行。
