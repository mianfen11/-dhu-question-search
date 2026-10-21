# 公开题库来源调查

更新：用户已在本次任务中明确声明获得平台自动化收集许可。1.2.0 据此启用串行自动访问，默认间隔5秒、1轮，最多10轮；不再采用1.1.0的未授权禁用状态。以下保留此前公开来源调查记录，不代表对本次用户授权的否定。没有重新请求受保护接口。

调查日期：2026-10-21。范围为 aidhu.net 的公开入口及其明确引用的静态资源，并做一次公开 GitHub 仓库检索；没有登录，没有猜测隐藏接口，本轮没有请求任何受保护 API，也没有执行第三方考试脚本。

## 已核验来源

| 来源 | 结果与依据 |
| --- | --- |
| https://aidhu.net/web/ | HTTP 200；HTML 仅有应用挂载点及 JS/CSS 资源引用，无内嵌题库或下载链接。 |
| https://aidhu.net/web/static/js/app.06f2eaf8.js | 此前公开下载，172987 字节；SHA-256 `95533ac023960667aec4bf3330a92ce7d9cc051cd0496492d61ddb941a8e9a1a`。无内嵌题库或题库下载文件链接；学生手册题目从 protected 接口动态加载。无 sourceMappingURL，未猜测 .map 路径。 |
| https://aidhu.net/web/static/js/chunk-vendors.2eba9b6c.js | HTTP 200，3728641 字节；第三方库包，检出的外链为库文档等，未发现题库 JSON/CSV/XLSX/PDF/ZIP 下载链接。sourceMappingURL 命中为库生成内联 source map 的代码，并非公开 .map 文件链接。 |
| https://aidhu.net/web/static/css/app.db45d697.css | HTTP 200，161845 字节；url() 指向背景图片 `/web/static/img/bg.02641129.png`，未发现题库数据文件。 |
| https://aidhu.net/sitemap.xml | HTTP 404，无公开站点地图可继续发现文件。该路径是标准公开索引检查，不是接口枚举。 |
| https://aidhu.net/robots.txt | 前一轮实测 404；本轮未重复请求。 |
| https://github.com/search?q=%E4%B8%9C%E5%8D%8E+%E5%AD%A6%E7%94%9F%E6%89%8B%E5%86%8C&type=repositories | HTTP 200，公开仓库检索返回一个结果 `codesimp1e/dhuhandbooktest`。这不是全网穷尽检索。 |
| https://github.com/codesimp1e/dhuhandbooktest | 公开读取代码成功。仅有 README.md、main.ipynb、jquery.min.js；Notebook 四个单元均无保存的输出，也无题库文件引用或静态 question 字典。README 描述 2021 年旧系统登录自动化，要求登录且写有研究用途/非商业限制，不是当前题库数据源。未执行其代码，未请求其提及的旧系统。 |

主应用包中可复核的代码：

```js
getOptionsArray(){const t=this.currentQuestion,e=[],s=["A","B","C","D","E"];for(const a of s)t[a]&&e.push({key:a,value:t[a]});return e}
```

判断题结果展示：

```js
if("judge"===t.question_type)return e.push({key:"1",label:"✓",value:"正确"},{key:"0",label:"✗",value:"错误"}),e;
```

练习页解析来自 `renderMarkdown(t.currentQuestion.source)`，结果页另引用 `s.explanation`。导入器因此兼容两个字段，保留原始记录。

加载逻辑仅发现以下六种手册路径（本轮未访问）：

```text
/api/protected/app/manual/list
/api/protected/app/manual/chapters
/api/protected/app/manual/exam_question
/api/protected/app/manual/chapter/questions/one_choice
/api/protected/app/manual/chapter/questions/multi_choice
/api/protected/app/manual/chapter/questions/judge
```

练习请求仅传 manual_id/chapter_id，三个 data 数组直接合并。前端没有分页加载、全章节遍历或整库统计调用，不能据此断言后端无限制或单次响应完整。前一轮匿名访问考试、章节、单选接口均返回 401 鉴权不通过；本轮遵照要求没有重试。

## 数据与完整性结论

已检查范围内未找到可匿名下载的完整真实题库 JSON 或题库下载文件。因此目前真实数据获取数量为 0，不能评估当前题库的章节覆盖率、题目总数或正确答案完整性。没有生成冒充真实题库的空库或模拟数据产物。

接下来需要公开且可信的数据文件链接，或平台方提供的授权导出。拿到数据后可使用本仓库离线工具统一格式、去重、保留冲突及来源；确认完整性仍需平台给出的手册版本、章节清单及各章各题型预期数量，不能以重复采样不再新增题目作为完整性证明。公开搜索使用许可须另行确认。


## 自动化访问条件核查

2026-10-21 本轮仅重新读取公开的 `https://aidhu.net/web/` 及该页引用的主应用 JS（`app.06f2eaf8.js`）；页面返回 200。检查 HTML 链接及应用中 terms/privacy/协议/条款/隐私/自动化等相关文本，未发现明确允许自动化章节遍历、重复抽题或规定请求间隔的公开条款。这不是已证明禁止，也不是已证明允许；未查到条款不能作为自动化授权。未登录、未请求受保护 API、未猜测隐藏接口。

现有公开前端的章节来源为 `/api/protected/app/manual/chapters`，GET 参数为 `manual_id`，前端按 ID→名称映射处理响应 data；题目来源仍是已知三种章节练习接口。前端只提供调用和渲染方式，不提供自动化许可、速率或完整题数证明。扩展 1.1.0 因此只被动观察正常章节清单与题目响应、持久化有限离线任务及统计，自动访问开关在界面和后台均关闭。

启用实际自动访问前，需从平台公开条款或平台方书面许可明确以下条件（不需要账号、密码或令牌）：

- 是否允许通过正常用户会话自动遍历章节、题型以及同章重复随机抽题；允许的接口和手册范围。
- 每用户/会话允许的最小请求间隔、并发上限、每日或单次访问量及暂停要求。当前没有明确数值，不能凭空称某个间隔符合平台规定。
- 有无官方全量导出或每章节/题型预期题数，用于独立验证完整性；连续零新增不证明收集完整。
- 若未来用于公开搜索，另需确认题目、答案和解析的再发布许可；自动访问许可本身不等于公开传播许可。
