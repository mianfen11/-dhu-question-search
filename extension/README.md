# Chrome 学生手册题目收集扩展

Chrome Manifest V3，要求 Chrome 111+。用户自行登录原网站，扩展只观察练习过程中已经发生的三个题目请求，不主动请求题目、不自动刷新、不自动切换章节。

## 安装与确认收集

1. 下载仓库到本地，保持 `extension/` 内文件完整。
2. Chrome 打开 `chrome://extensions`，开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本仓库的 **extension 目录**，不是仓库根目录。
4. 用户自行登录 `https://aidhu.net/web/`，手动进入学生手册某章节的练习模式。
5. 点击工具栏扩展图标查看已收集总数、单选/多选/判断数量及最近保存时间。可固定该图标。
6. 手动切换章节正常练习，再打开弹窗；出现新的不同题目时数量增加。重复加载同一章节不会重复计数。没有新题时最近保存时间仍会更新。

安装前已经返回的数据不会被追溯读取；安装后请手动重新进入练习页面，必要时自行刷新一次。扩展自身不会刷新或重放请求。SPA 在聊天/手册列表/练习页面之间切换无需重装扩展，脚本在 `/web/*` 文档启动时注册、每次请求时检查当前路由。

只收集 `https://aidhu.net/web/#/main/handbookAnswer` 且 `mode` 为 `practice`（或省略）的数据。考试模式、其他路由、子框架和其他网站不收集。

## 导出和导入

- 点击“导出 JSON”，Chrome 发起 `dhu-question-bank-日期.json` 下载。文件包含 `schema_version:1`、标准化的 `questions` 和 `report`。请检查 Chrome 下载列表确认成功。
- 点击“导入 JSON”选择本地文件，自动合并并显示新增、重复合并和拒绝数量。支持 UTF-8/BOM、最多 20 MB、单次最多 50000 道题；不读取 URL 或下载远程文件。
- 支持原始 API 的 `data` 数组、普通题目数组、Python 工具导出以及本扩展导出，亦支持 `questions`、`items`、章节/题型分组。部分记录无效时保留有效题目并显示错误位置；文件结构或 JSON 语法无效时不写入题库。
- 导出可直接交给仓库已有 Python 工具：

```bash
python3 tools/question_bank.py downloaded.json -o /tmp/normalized-bank.json
```

题型、A～E 选项、答案转换规则与 [Python 导入说明](../docs/import.md) 对齐。单选/多选统一为字母数组，判断统一为 `["1"]` / `["0"]`；不猜测判断题 A/B 的含义。

去重键包含手册、章节、题型、题干、选项和答案，生成方式与 Python SHA-256 一致。不同章节同题分别保留；同题不同答案不覆盖，弹窗提示待核对冲突。同一内容的不同 ID 和解析分别保存在 `question_ids`、`explanations` 中。未知字段不会导入；原始响应、任意 provenance/raw、请求对象等不会存储，以免混入认证信息。

默认 Chrome local 存储配额约 10 MB，扩展不申请 unlimitedStorage。写入失败会返回错误且不覆盖已有题库；大量数据请定期导出备份。未提供自动清空操作。`chrome.storage.local` 在同一浏览器配置文件关闭重开后应保留；卸载扩展或清除扩展数据会删除题库，不要将其当作唯一备份。不会同步到 Google 账户。

## 实现与通信边界

- `manifest.json`：仅 storage 权限，MAIN 与 ISOLATED 两组 document_start 内容脚本，限定 `https://aidhu.net/web/*`，不申请 Cookie、webRequest、debugger、tabs、跨域请求或下载权限。`connect-src 'none'` 阻止扩展页面发起外部连接。
- `observer.js`（MAIN）：包装原有 fetch / XHR.open。fetch 使用响应 clone 读取，不消费原响应，返回原 promise；XHR 使用 load 监听，不替换页面自己的事件处理器。不读取请求头、请求体、密码、Cookie、Authorization 或本地登录存储。不注入 Authorization，不保存完整请求 URL。
- URL 严格限定 HTTPS、`api.aidhu.net`、精确的三种接口路径及正常 GET；拒绝用户信息 URL、重复/非法章节参数及跨来源重定向。跨消息仅保留路径、题型、manual_id、chapter_id 和已筛选的题目字段。
- `content.js`（ISOLATED）：核对事件的 window、精确 origin、版本、路由、元数据、字段类型及大小。再做一次白名单投影，之后通过 chrome.runtime.sendMessage 发给后台。
- `background.js`：再次核对扩展 ID、顶层内容脚本来源和页面路由；导入/导出/统计仅允许扩展自身 popup.html。存储设置为 TRUSTED_CONTEXTS，网页和内容脚本不能直接读写扩展存储。所有读改写串行执行，避免三个接口或多个标签页同时响应时覆盖数据。
- `core.js` / `entities.js`：共享规范化与 HTML 实体解码，无远程依赖，不执行 HTML。`store.js` 仅保存规范化题目、ID、解析和状态；弹窗使用 textContent 显示文本。

网页上下文并非可信执行环境：同站页面脚本能观察/替换自己的 fetch，也可能伪造符合格式的桥接消息。来源和 schema 校验能够拒绝任意消息及越界数据，但 **不能用来密码学证明题目来自服务器**。本扩展不声称具备这种能力，不把 window 消息当作认证或授权依据，也不允许网页借消息读取/导出题库或操作浏览器权限。导入/导出的完整性和公开使用许可仍标为 unverified。

为避免异常数据占用无限内存：fetch 响应读取最多 5 MiB，每响应最多 10000 行；每字段最多 50000 字符，桥接每批最多 100 行且最多 1M 字符，隔离脚本待处理队列最多 200 批。超限或错误响应会被忽略，不能据此认为已获得全部题目。若原站改用 Worker、WebSocket 或其他接口，本版不会收集。

## 自动化与手动验收

在仓库根目录运行（Python 3.10+、Node.js 22+）：

```bash
python3 -m unittest discover -s tests -v
node --test tests/extension/*.test.cjs
```

Node 测试覆盖精确来源/路径、SPA 切换、fetch/XHR、坏响应、白名单过滤、批次拆分、并发存储、配额错误、去重/冲突、弹窗导入导出逻辑以及与 Python 的规范化/导出兼容性。

`browser.test.cjs` 是独立真实 Chromium MV3 集成测试：使用 CDP 提供虚构页面及虚构接口响应，不向真实 aidhu 接口发请求。测试包含真正内容脚本与后台、弹窗文件导入/下载、浏览器重启后的保存验证。可通过 `CHROMIUM_BIN` 指定可执行文件。Chromium 未安装或管理员明确禁止加载未打包扩展时，会显式跳过并说明原因；其他失败不会吞掉。

本次云端结果：**Python 14 项通过；Node 27 项通过、1 项跳过、0 失败。** Chromium 154 明确返回 `Loading of unpacked extensions is disabled by the administrator.`，因此 **没有验证真实 MV3 安装/运行成功**，没有使用真实登录页面。

需在自己的 Chrome 逐项验收：

1. 加载扩展无清单/脚本错误；自行登录原站不受影响。
2. 从手册列表或其他 SPA 页面进入练习，三种题型数量与该次已加载数据相符。
3. 重复进入相同章节不新增重复题，进入不同章节能合并；页面切换后仍然收集。
4. 页面网络错误时仍能正常操作，其他网站/考试页面不触发收集。
5. 关闭 Chrome 后重新打开，题数保留；扩展后台休眠后再次练习能够继续保存。
6. 点击导出确认真实下载文件，Python 导入成功；重新导入该文件不增加重复题，导入不同题目时正确合并。
7. 同时打开多个练习标签页正常加载，验证数量不丢失；弹窗及时刷新统计。

已收集数量只代表已保存内容，不代表完整题库或公开发布授权。
