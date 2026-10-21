# 东华学生手册题库数据工具

当前包含 Chrome 题目收集扩展及离线 JSON 清洗工具，不包含搜索网站。尚未取得完整真实题库。

- [Chrome 扩展安装、使用及验收说明](extension/README.md)：1.2.0 支持用户授权后串行自动收集（默认5秒、1轮）、任务恢复、跨章节去重及 JSON 导出；保留正常练习的被动收集。
- [离线 JSON 导入说明](docs/import.md)：Python 3.10+，无第三方依赖。
- [此前公开来源调查](docs/investigation.md)。

从仓库根目录运行：

```bash
python3 tools/question_bank.py input1.json input2.json -o /tmp/question-bank.json
python3 -m unittest discover -s tests -v
node --test tests/extension/*.test.cjs
```

扩展导出的 JSON 可直接作为 Python 工具的输入。Node 测试要求 Node.js 22+；真实 Chromium 测试在未安装浏览器或管理策略明确禁止加载扩展时显式跳过。测试使用模拟数据，不需要登录或访问受保护接口。
