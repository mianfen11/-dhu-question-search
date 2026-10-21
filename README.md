# 东华大学学生手册题目检索

纯静态的中文题目搜索工具，支持完整题干/多行粘贴、关键词检索、题型筛选、手机访问和 GitHub Pages。已核实的完整答案以浅绿色区域醒目展示；区分选项乱序、答案冲突及待核实记录。无登录、后端、在线 AI 或原平台 API 调用。

**本次交付的初始正式题库为 0 道；后续以页面实际统计为准。** 仓库没有可用的真实题库导出，本次没有把测试题放入正式数据。网站可以正常打开；取得实际扩展导出后，运行下列命令即可更新，不需要修改网站代码。

- 网站：[web/](web/)，入口 [web/index.html](web/index.html)，正式数据 [web/question-bank.json](web/question-bank.json)。
- [网站使用、数据结构、检索策略及验收说明](docs/search-site.md)。
- [Chrome 扩展 1.3.0](extension/README.md)：正常登录后按授权串行收集；增量持久化、安全迁移、回执恢复和 JSON 导出。
- [原 Python JSON 导入工具](docs/import.md) 与 [此前公开来源调查](docs/investigation.md)。

## 本地运行

在仓库根目录执行：

```bash
python3 -m http.server 8000 --directory web
```

打开 `http://localhost:8000/`。使用须知确认后即可搜索。不要直接双击 HTML：ES modules、Worker 和 JSON 读取需要 HTTP 服务。无需安装依赖或构建。

## 将扩展 JSON 转成网站题库

默认扩展文件下载到 Downloads。首次转换（将该目录中所有扩展导出一起归并）：

```bash
python3 tools/build_search_bank.py "$HOME"/Downloads/dhu-question-bank-*.json \
  -o web/question-bank.json
```

也可以把通配符换成一个或多个实际文件路径。工具支持扩展 1.2.0、原始 API data 数组及原 Python 工具的标准 JSON；它只读本地文件，不请求接口。

日常增量更新（保留网站已有版本和冲突，重复导入不增加重复题）：

```bash
git pull --ff-only origin main
python3 tools/build_search_bank.py "$HOME"/Downloads/dhu-question-bank-*.json \
  --merge web/question-bank.json -o web/question-bank.json
python3 -m unittest discover -s tests -v
node --test tests/web/*.test.mjs
git add web/question-bank.json
git commit -m "Update handbook search bank"
git push origin main
```

请在本地 `main` 分支、仓库根目录执行；Windows 可用 `py` 替换 `python3`，并将输入路径改成实际下载文件。没有匹配文件、JSON 损坏或历史映射校验失败时停止，不覆盖原题库。没有数据变化导致 Git 无新内容时，无需提交。

转换输出五项统计：原始输入记录数 `input_records`、归并后题数 `unique_questions`、成功映射记录数 `mapped_answer_records`、冲突题数 `conflict_questions`、含待核实版本的题数 `unverified_questions`。冲突/无法映射的记录会保留，不会被丢弃或猜测答案。

## GitHub Pages 免费部署

1. 仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。无需密钥。
2. **Actions → Deploy search site to GitHub Pages → Run workflow → main → Run workflow**。
3. 等待部署成功，在任务的 `github-pages` 环境或 Settings → Pages 查看实际网址。默认项目地址预计为 `https://mianfen11.github.io/-dhu-question-search/`，以 GitHub 显示为准。
4. 此后推送 `web/` 变化到 `main`，工作流自动校验数据并重新部署；只发布 `web/`，不会发布扩展、原始导出或测试夹具。

已添加 [.github/workflows/pages.yml](.github/workflows/pages.yml)，本次没有代替你修改远程 Pages 设置，也没有确认线上部署成功。若 Actions 报 Pages 尚未启用，请先完成第 1 步后重新运行。所有资源均使用相对路径，支持仓库子路径。

## 全部测试

Python 3.10+、Node.js 22+，无 npm 或 pip 依赖：

```bash
python3 -m unittest discover -s tests -v
node --test tests/extension/*.test.cjs tests/web/*.test.mjs
```

静态网站真实 Chromium 测试使用本地 HTTP 服务和虚构夹具，验证桌面、移动视口、键盘、弹窗偏好、搜索、答案版本、分页及子路径；不会调用原平台。可设置 `CHROMIUM_BIN` 指向浏览器，缺少 Chromium 时明确跳过。扩展的真实 MV3 测试在云端仍因管理员策略跳过；本次未修改其采集逻辑。

Safari、真实 iPhone/Android、屏幕阅读器及 GitHub Pages 线上行为尚需人工验收。测试数据仅存在于测试进程中，不会生成到正式题库。
