# Chrome 学生手册题目收集扩展

Chrome Manifest V3，要求 Chrome 111+。用户自行登录原网站，扩展只观察练习过程中已经发生的三个题目请求，不主动请求题目、不自动刷新、不自动切换章节。

## 安装与确认收集

1. 下载仓库到本地，保持 `extension/` 内文件完整。
2. Chrome 打开 `chrome://extensions`，开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本仓库的 **extension 目录**，不是仓库根目录。
4. 用户自行登录 `https://aidhu.net/web/`，手动进入学生手册某章节的练习模式。
5. 点击工具栏扩展图标查看已收集总数、单选/多选/判断数量及最近保存时间。可固定该图标。
6. 手动切换章节正常练习，再打开弹窗；出现新的不同题目时数量增加。重复加载同一章节不会重复计数。没有新题时最近保存时间仍会更新。

安装前已经返回的数据不会被追溯读取；安装后请手动重新进入练习页面，必要时自行刷新一次。扩展自身不会刷新或重放请求。SPA 在聊天/手册列表/练习页面之间切换无需重装扩展，脚本在根入口 `/` 或 `/web/*` 文档启动时注册、在响应返回和消息转发时检查当前路由。

只收集 `https://aidhu.net/web/#/main/handbookAnswer` 或根入口 `https://aidhu.net/#/main/handbookAnswer` 且 `mode` 为 `practice`（或省略）的数据。考试模式、其他路由、子框架和其他网站不收集。

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

- `manifest.json`：storage 与 scripting 权限，MAIN 与 ISOLATED 两组 document_start 内容脚本，限定 `https://aidhu.net/` 及 `https://aidhu.net/web/*`，不申请 Cookie、webRequest、debugger、tabs 或下载权限；host permission 仅限 aidhu.net 供 MAIN 补注入使用，不含 api.aidhu.net。`connect-src 'none'` 阻止扩展页面发起外部连接。
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

本次云端结果：**Python 14 项通过；Node 57 项通过、1 项跳过、0 失败。** Chromium 154 明确返回 `Loading of unpacked extensions is disabled by the administrator.`，因此 **没有验证真实 MV3 安装/运行成功**，没有使用真实登录页面。

需在自己的 Chrome 逐项验收：

1. 加载扩展无清单/脚本错误；自行登录原站不受影响。
2. 从手册列表或其他 SPA 页面进入练习，三种题型数量与该次已加载数据相符。
3. 重复进入相同章节不新增重复题，进入不同章节能合并；页面切换后仍然收集。
4. 页面网络错误时仍能正常操作，其他网站/考试页面不触发收集。
5. 关闭 Chrome 后重新打开，题数保留；扩展后台休眠后再次练习能够继续保存。
6. 点击导出确认真实下载文件，Python 导入成功；重新导入该文件不增加重复题，导入不同题目时正确合并。
7. 同时打开多个练习标签页正常加载，验证数量不丢失；弹窗及时刷新统计。

已收集数量只代表已保存内容，不代表完整题库或公开发布授权。

## 1.0.1 历史修复

修复两个已由回归测试复现的 SPA 丢题条件：后台不再以可能过时的 `sender.tab.url` 快照判断当前练习路由，仍校验发送文档来源、顶层 frame、扩展 ID 及隔离脚本传来的实时练习地址；fetch/XHR 在请求启动时只匹配精确接口，在异步响应返回时检查练习路由，避免 Vue 更新地址之前启动的加载被丢弃。清单仍使用 document_start 和 MAIN/ISOLATED 两个世界，调整为先注册隔离接收器，再安装页面监听。未增加权限、接口或请求。

更新本地已解压扩展：

1. 在原仓库目录执行 `git pull --ff-only`（若修复尚未推送，则用包含修复提交的代码更新同一目录）。
2. 打开 `chrome://extensions`，找到收集器，点击“重新加载”，确认版本为 **1.0.2**。不要卸载，以免删除 local 数据。
3. 手动刷新已经打开的 aidhu 页面一次；扩展重新加载不会替换旧页面里已失效的内容脚本。然后自行登录并重新进入章节练习。
4. 打开弹窗检查题数和最近保存时间；手动重复该章节及切换另一章节，检查去重和合并。之前漏掉的响应无法追溯，需正常重新进入章节后再次加载。

新增回归覆盖：登录/首页标签元数据滞后、Vue 哈希更新前启动 fetch/XHR，以及完整 observer→isolated→worker→storage 链路在章节切换中合并三种题型且不额外发请求。真实 Chrome 管理策略限制仍然存在，必须在本地验收，测试通过不代表已在用户登录会话中复现并验证。

## 1.0.2 历史版本：分阶段诊断

此前代码所有解析异常和后台失败均被静默忽略，单凭 0 无法证明故障发生在哪一层。本版修复这种静默失败，并将 Manifest、页面路由及后台来源校验统一覆盖公开应用的 `/` 和 `/web/` 两个入口。根入口原先不会注入；这属于代码可确认的覆盖缺口，但没有证据表明它就是用户当前登录会话的唯一原因。精确 API 域名仍是 `https://api.aidhu.net`，路径仍仅限三个章节题型接口，没有增加请求或接口猜测。

打开扩展弹窗查看“当前标签页诊断”（需让 aidhu 标签页处于活动状态）：

| 状态 | 已取得的证据/下一步 |
| --- | --- |
| 监听脚本未注入或未完成握手 | 无隔离脚本应答时会提示检查页面地址/网站访问权限并刷新；隔离脚本存在但 MAIN 未应答时单独提示，不将无应答当作已证明未注入。 |
| 监听已启动，尚未捕获题目响应 | MAIN 与隔离脚本握手成功；若网页覆盖了 fetch/XHR 包装，显示专门说明。请手动正常进入章节。 |
| 捕获响应或消息，但解析失败 | 显示固定原因：非成功 HTTP、JSON 无效、code/data 结构不符、接口参数、最终 URL 不符、字段白名单或规范化失败等。不显示原始响应或异常文本。空 data 明确标为空响应。 |
| 解析成功，但后台通信或存储失败 | 区分后台无法确认、存储权限初始化、读取本地库、写入/配额失败。未收到逐行处理确认时不显示“成功保存”。 |
| 成功保存题目 | 必须收到后台已完成 storage.local.set 的成功回执；保存/合并计数包含重复题目，不等于新增题目总数。 |

“已捕获，正在解析”和“解析成功，正在保存”是短暂处理中状态。诊断计数属于当前页面文档最近的观察；原有总题数仍从持久化题库读取，二者不同。页面刷新会重置本页诊断，不会清空题库。弹窗打开期间每秒仅发送一次本地状态探测消息，不请求接口、不刷新页面、不重放题目响应。

诊断仅使用固定状态/原因枚举、布尔值和计数；不持久化诊断日志，不包含完整 URL、查询参数、题干、Cookie、Token、Authorization 或原始错误。网页传来的诊断也会验证 window、origin、字段集合、枚举和大小；弹窗查询只接受本扩展自身 popup.html。

更新：在原目录获取 main 最新代码，在 chrome://extensions 点击“重新加载”，确认 **1.0.2**，然后**手动刷新原站页面**并进入练习。无需卸载。若仍为 0，只需反馈诊断标题、原因说明及四个计数，不需要提供账号、请求头或认证信息。

本版补充的测试覆盖五个阶段、监听握手/被覆盖、空或异常响应、接口参数拒绝、后台失败回执、根路径来源限制，以及敏感字段不进入诊断。云端真实 MV3 测试仍受管理员策略限制而跳过；不把模拟测试当作已验证用户浏览器能正常收集。

## 1.0.3 当前版本：MAIN 启动与双向握手

针对“隔离脚本存在但 MAIN 未应答”，修复了旧代码的两个可确认缺口：安装监听前就置位的布尔标记会在初始化异常后永久阻止重试；单次 probe/ready 不含轮次关联，也不能证明双向通道已经完成。不能把这些代码缺口直接当作已证明的用户浏览器根因。

### 启动与握手

- MAIN 静态脚本仍在 `document_start` 执行。清单顺序为 `main-bootstrap.js`、`entities.js`、`core.js`、`observer.js`。bootstrap 不依赖 core，先安装消息接收器；ISOLATED 先加载 `handshake.js` 再启动 content。不能依赖两个世界之间的先后顺序。
- bootstrap → hello，ISOLATED → challenge，MAIN → ack，ISOLATED → confirm，MAIN → confirmed。hello/旧 ready 都不等于成功；只有本页 session、本轮 seq 对应且监听器完成安装的 confirmed 才标记 ready。消息 ID 不是认证令牌，不进入弹窗或存储。
- 在 100/250/500/1000/1500 毫秒重试，整轮超时 2000 毫秒。先启动哪个世界、早期 hello/probe 丢失、MAIN 稍后才加载，都可通过后续握手恢复。监听器使用 capture 阶段接收，但不阻止网页原来的消息处理。
- 安装完成后才设置版本化的 observerInstalled 状态；若安装 fetch/XHR 时抛错则回滚本次已安装的包装并报告具体失败阶段。重复注入不会叠加包装；旧版布尔标记不会阻止新版启动。

### 有明确结果的补注入

350 毫秒仍未确认时，隔离脚本最多请求后台补注入一次。增加 **scripting** 权限及 `aidhu.net` 的 host permission，仅用于这个启动恢复过程。没有增加 api.aidhu.net 权限，也不读取认证信息或主动请求题目。Chrome 的 host permission 在 API 层按主机授权；后台另外严格检查 aidhu 的根路径或 /web/ 路径、顶层 frame 和浏览器提供的 documentId。

后台使用 `chrome.scripting.executeScript({world:'MAIN', injectImmediately:true, target:{tabId,documentIds:[原documentId]},files:[...]})`，再通过同一文档的 MAIN 状态检查返回证据。没有 DOM script 标签、内联脚本或远程脚本。原文档失效时不会改向新文档注入。补注入可能晚于首个页面请求，因此不承诺追回启动前的数据；仍需用户正常重新进入章节，不重放请求。

### 弹窗能区分的 MAIN 失败

- `main_bootstrap_timeout`：2 秒内没看到 bootstrap 回执，不能据此认定 CSP。
- `main_ack_timeout`：bootstrap 已出现或 Chrome 已确认 MAIN 执行，但本轮 challenge 没有匹配 ack。
- `main_confirm_timeout`：收到 ack，但双向确认或监听器就绪仍未完成。
- `main_core_missing` / `main_entities_missing` / `main_observer_pending`：bootstrap 能运行，但相应依赖或监听器没完成。
- `main_fetch_patch_failed` / `main_xhr_patch_failed`：MAIN 已运行，安装该监听函数时抛错。不会输出原异常文本。
- `main_csp_blocked`：**只有 Chrome 补注入错误明确提及 CSP 时**才显示。
- `main_injection_denied` / `main_document_gone` / `main_file_missing`：分别表示 Chrome 权限/策略拒绝、原文档失效、脚本文件无法加载。其他未能安全归类的错误会明确标出 Chrome 补注入失败或返回状态不符合预期，而非猜测原因。

2026-10-21 对公开 `/web/` HTML 做了一次只读检查：HTTP 200，未见 CSP/CSP-Report-Only 响应头或 CSP meta。该结果不代表用户登录会话、其他扩展或浏览器策略也没有限制；未请求任何题库 API。

### 更新与验收

1. `git pull --ff-only` 更新原目录全部文件，勿遗漏新增的 `main-bootstrap.js` 和 `handshake.js`。
2. 在 chrome://extensions 重新加载扩展，确认 **1.0.3**；若 Chrome 因新增 scripting/站点权限要求确认，允许扩展访问 aidhu.net。无需卸载。
3. 手动刷新原网站，再打开弹窗。成功时显示已启动/已保存；补注入成功时会显示已恢复。失败时会显示具体 MAIN 阶段、bootstrap 是否已见、握手轮次和 2000 毫秒超时。
4. 再正常进入章节。若失败，只反馈这些固定诊断文案，不需要提供 Cookie、Token 或请求头。

回归测试覆盖 MAIN-first/ISOLATED-first、早期消息丢失、缺失 ack/confirmed、错误 session/seq、缺依赖、初始化抛错后重试、旧布尔标记、重复注入、原 documentId 定位及 CSP/权限错误脱敏。真实 MV3 测试仍因云端管理员策略禁止加载未打包扩展而跳过，未宣称在用户真实登录会话中验证成功。
