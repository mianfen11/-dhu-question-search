# 离线 JSON 导入与导出

运行目录为仓库根目录。可一次传入多个 UTF-8（可带 BOM）JSON 文件：

```bash
python3 tools/question_bank.py input1.json input2.json -o /tmp/bank.json
```

支持题目数组、单个题目，以及 `data`、`questions`、`items` 封装。支持 `chapters` 数组和 `one_choice` / `multi_choice` / `judge` 题型分组；封装上的 `manual_id`、`chapter_id`、`question_type` 传递给下层记录。失败响应或未知结构会报告，不能当作空题库成功导入。不递归搜寻任意数组，不跟随 JSON 中的 URL。

以下仅为虚构格式示例，不是真实题库：

```json
{
  "manual_id": 1,
  "chapters": [{
    "chapter_id": 1,
    "one_choice": [{"question_id": "demo-1", "question": "模拟题", "A": "甲", "B": "乙", "answer": "A", "source": "模拟解析"}],
    "multi_choice": [{"question": "模拟多选", "A": "甲", "B": "乙", "E": "戊", "answer": "A,E"}],
    "judge": [{"question": "模拟判断", "answer": "1"}]
  }]
}
```

输入兼容性：

- 题型：`question_type` 或 `type`；标准三种题型及中文单选题/多选题/判断题，英文 `single` / `multiple` / `boolean`。
- 题干：`question` / `question_content` / `stem` / `title`。
- 选项：顶层 `A`～`E`、小写字母、`option_a` 等；或 `options` 对象、最多五个文本的数组、`{key,value}` 对象数组。标签还支持 `label` / `id`，内容还支持 `text` / `content`。多处选项定义冲突时报错。
- 答案：`answer` / `answers` / `correct_answer`。选择题支持 `A`、`AC`、`A,C`、空格/中文逗号/顿号/分号/竖线/斜线分隔、字母数组和 JSON 数组字符串；支持小写及全角字母。输出为排序去重后的字母数组。不会猜测数字答案的索引基准，不会把选项正文自动映射为字母。
- 判断题支持布尔值、0/1、true/false、正确/错误、对/错、是/否、✓/✗、√/×，统一输出 `["1"]` 或 `["0"]`。没有证据表明 A/B 分别代表真假，因此拒绝这种含糊输入。判断题不接受额外字母选项。
- 解析：`explanation` / `analysis` / `source`。公开前端练习页将 `source` 用作解析内容；原字段保存在 provenance.raw 中，避免误解其原意。

清洗只做 Unicode NFC、HTML 实体解码、换行统一和首尾空白清理，保留 Markdown、HTML、图片地址及题干内部空格；不执行或渲染内容。需要显示到网页时应另做安全渲染。不会补写缺失的题目或解析。

输出包含 `schema_version`、`questions` 和 `report`：

- 每题统一为 `question_id`、`manual_id`、`chapter_id`、`question_type`、`question`、`options`、`answer`、`explanation`；ID 统一为字符串或 null。
- `record_id` 是标准化后的手册、章节、题型、题干、选项和答案的 SHA-256。
- 仅当上述内容一致时合并；不同手册/章节保留独立记录。不因相同 question_id 而覆盖内容。
- 合并时保留全部 `provenance`（文件、记录索引、原 ID、原始记录）及不同 `explanations`。相同 ID 对应不同内容、同题不同答案会同时保留并报告 `conflicts`。
- `report` 给出输入数、去重后数量、合并数量、按题型计数、拒绝内容及原因。结构级错误可能拒绝整个文件，其原文对象仍保存在报告中。
- `completeness` 和 `public_reuse_permission` 始终为 `unverified`：导入成功或去重数稳定不证明整库完整，也不证明公开使用许可。

退出码：0 表示非空且无拒绝/冲突；1 表示读取/JSON 解析失败；2 表示拒绝、冲突或空题库，需要人工复核。拒绝或冲突时仍输出可审查结果，不应直接发布。语法错误时不改已有输出。输出原子替换，禁止输出路径覆盖输入。导出的 questions 可再次导入；raw 内保留之前来源。

测试中的内容均为模拟数据，不能用作真实题库或完整性证据。
