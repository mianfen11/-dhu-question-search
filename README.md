# 东华学生手册题库数据工具

当前仅包含离线数据导入、清洗、格式统一、去重及 JSON 导出工具，未开发 Chrome 扩展或搜索网站。**尚未取得完整真实题库**。

需要 Python 3.10+，无第三方依赖。程序不发出任何网络请求。

```bash
python3 tools/question_bank.py chapter1.json chapter2.json -o /tmp/question-bank.json
python3 -m unittest discover -s tests -v
```

详细输入格式、去重规则、退出码和限制见 [导入说明](docs/import.md)。公开来源调查见 [调查记录](docs/investigation.md)。
