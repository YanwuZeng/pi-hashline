# Hash-Anchored Edit — Prompt 工作流测试场景

本文档描述 prompt-driven 工作流测试场景，模拟"收到自然语言提示词 → 根据
prompt guidelines 构造正确的 read/edit 指令 → 执行并验证"的完整流程。

---

## 场景 1: 重命名变量 (patch)

**用户提示**:
> 把 greet.ts 中的 `oldName` 改成 `newName`

**Agent 工作流**:
1. `read` 读取文件，获取含锚点的内容
2. 找到包含 `oldName` 的行，记下 LINE#HASH
3. `edit` 使用 `op=patch`，`old="oldName"`，`new="newName"`

**验证**: 文件中 `oldName` → `newName`

---

## 场景 2: 替换整行 (replace)

**用户提示**:
> 把 config.json 里的 debug 从 false 改成 true

**Agent 工作流**:
1. `read` 读取 JSON 文件，找到 `"debug": false` 所在行
2. `edit` 使用 `op=replace`，替换整行为 `"debug": true,`

**验证**: 文件中 `"debug": true`

---

## 场景 3: 在某行后插入 (after)

**用户提示**:
> 在 schema.ts 的 name 字段后面加一个 email 字段

**Agent 工作流**:
1. `read` 读取文件
2. 找到 name 行的 LINE#HASH
3. `edit` 使用 `op=after`，插入 email 行

**验证**: `name` → `email` → `age` 的顺序

---

## 场景 4: 删除某行 (delete)

**用户提示**:
> 删除 service.ts 里的 oldMethod 方法行

**Agent 工作流**:
1. `read` 读取文件
2. 找到 oldMethod 行的 LINE#HASH
3. `edit` 使用 `op=delete`

**验证**: oldMethod 行不存在，其他行正常

---

## 场景 5: 一次调用多个编辑

**用户提示**:
> 把 version 升到 2.0.0，author 改成 team

**Agent 工作流**:
1. `read` 读取 package.json
2. 找到 version 行和 author 行
3. `edit` 一次调用两个 `op=patch`

**验证**: version="2.0.0", author="team"

---

## 场景 6: Hash 不匹配后重试

**用户提示**:
> 把 retry.txt 的 original 改成 modified

**Agent 工作流**（模拟外部修改导致 hash 过期）:
1. `read` 获取锚点
2. 外部修改文件
3. 尝试 `edit` → 抛出 `Hash mismatch`
4. 根据 prompt guidelines 重新 `read`
5. 用新锚点重试 `edit`

**验证**: 最终文件正确修改

---

## 场景 7: 在某行前插入 (before)

**用户提示**:
> 在文件顶部加一行 import

**Agent 工作流**:
1. `read` 读取文件
2. 找到第一行的 LINE#HASH
3. `edit` 使用 `op=before`

**验证**: import 在最前面

---

## 场景 8: 读取窗口后编辑

**用户提示**:
> 看看第 5 到 10 行的内容，然后把第 7 行改了

**Agent 工作流**:
1. `read` 使用 `offset=5, limit=6`
2. 从窗口中找到 line7 的锚点
3. `edit` 修改 line7

**验证**: 第 7 行被正确修改，其他行不变

---

## 场景 9: Dry-run 预览再执行

**用户提示**:
> 先给我看看改动效果，确认了再改

**Agent 工作流**:
1. `read` 获取锚点
2. `edit` 使用 `dryRun=true` → 返回 diff，文件不变
3. 确认后，再 `edit` 一次（不带 dryRun）

**验证**: dry-run 时文件不变，最终文件正确修改

---

## 场景 10: 多行替换

**用户提示**:
> 把 math.ts 里的 // TODO 替换成真正的加法实现

**Agent 工作流**:
1. `read` 获取锚点
2. 找到 `// TODO` 行
3. `edit` 使用 `op=replace`，new 包含多行代码

**验证**: TODO 被替换为 `const result = a + b;\n  return result;`

---

## 场景 11: 分页读取

**用户提示**:
> 文件很大，分页读取，每次 5 行

**Agent 工作流**:
1. `read offset=1, limit=5` → 显示 1-5 行 + 继续提示
2. `read offset=6, limit=5` → 显示 6-10 行 + 继续提示
3. `read offset=11, limit=5` → 显示 11-12 行
4. 用第 2 步的锚点修改第 6 行

**验证**: 正确读取所有分页，编辑生效

---

## 场景 12: CRLF 文件工作流

**用户提示**:
> 修复 Windows 配置文件里的拼写错误

**Agent 工作流**:
1. `read` 读取 CRLF 文件（锚点不含 `\r`）
2. 找到 `fals` 行
3. `edit` 使用 `op=patch`
4. 输出保持 CRLF

**验证**: 锚点干净无 `\r`，输出保持 `\r\n`

---

## 场景 13: 完整工作流 read → dry-run → edit

**用户提示**:
> 我不确定这个改动对不对，先让我看看效果

**Agent 工作流**:
1. `read` 读取组件文件
2. `edit` 使用 `dryRun=true` 预览 diff
3. 确认后 `edit` 实际执行

**验证**: dry-run 阶段文件不变，最终正确修改
