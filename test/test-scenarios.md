# Hash-Anchored Edit — 测试 Prompt 场景

以下场景用于验证 `read` 和 `edit` 工具的实际行为。
每个场景包含初始内容、操作步骤和预期结果。

---

## 场景 1: 基础行替换

**初始文件** (`scenario-1.txt`):
```
alpha
beta
gamma
```

**操作**: `edit` → `replace` line 2 (`beta` → `BETA`)

**预期结果**:
- 文件变为 `alpha\nBETA\ngamma\n`
- 返回值包含 `--- Anchors 2-2 ---` 和更新后的 hash

---

## 场景 2: 多行插入（before）

**初始文件** (`scenario-2.txt`):
```
second
third
```

**操作**: `edit` → `before` line 1 → new=`first`

**预期结果**:
- 文件变为 `first\nsecond\nthird\n`

---

## 场景 3: 行级 patch

**初始文件** (`scenario-3.txt`):
```
function greet(name) {
  return "Hello, " + userName;
}
```

**操作**: `edit` → `patch` line 2, old=`userName`, new=`name`

**预期结果**:
- 文件变为 `function greet(name) {\n  return "Hello, " + name;\n}`
- `displayDiff` 显示正确的增减行

---

## 场景 4: dryRun 不写文件

**初始文件** (`scenario-4.txt`):
```
before
after
```

**操作**: `edit` → `replace` line 1 → new=`changed`, `dryRun=true`

**预期结果**:
- 文件内容不变
- 返回值包含 `No file written.`
- 返回值包含 diff 信息

---

## 场景 5: 多次编辑一次调用

**操作**:
1. `read` 获取所有锚点
2. `edit` 一次调用三个修改:
   - line 1: patch (old=`a` → `A`)
   - line 3: replace → `C`
   - line 5: delete

**预期结果**:
- 所有编辑按行号逆序执行
- 最终文件正确
- `displayDiff` 包含所有变更

---

## 场景 6: hash 过期拒绝

**操作**:
1. 读取文件获取锚点
2. 外部修改该行内容
3. 使用旧锚点编辑 → 应抛出 `Hash mismatch`

**预期结果**: 编辑被拒绝，文件不变

---

## 场景 7: CRLF 行尾保留

**初始文件** (`scenario-7.txt`, Windows CRLF):
```
a\r\nb\r\nc\r\n
```

**操作**: `edit` → `replace` line 2 → new=`B`

**预期结果**: `a\r\nB\r\nc\r\n`（CRLF 保留）

---

## 场景 8: 分页读取

**操作**:
1. `read` offset=1, limit=2
2. `read` offset=3, limit=2

**预期结果**:
- 第一次返回 lines 1-2 + 继续提示
- 第二次返回 lines 3-4

---

## 场景 9: 编辑后重新读取

**操作**:
1. `read` 获取全部锚点
2. `edit` 修改 line 1
3. 再次 `read` 重新获取文件

**预期结果**:
- 第二次 read 返回的 line 1 hash 与第一次不同

---

## 场景 10: 二进制文件检测

**操作**: `read` 一个二进制文件（含 null 字节）

**预期结果**:
- `details.binary === true`
- 内容显示 `Binary or non-text file`
