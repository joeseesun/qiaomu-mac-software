# 研究记录

2026-11-24 对 skills.sh、SkillsMP 并行查询了 macOS 已装应用、软件分享与图标提取。统一检索返回 56 个候选族。目录结果只能说明被发现，未据此宣称覆盖、质量或安装成功。

- 乔木 [信息卡技能](https://github.com/joeseesun) 的本地 `qiaomu-info-card-designer` 工作流。保留预览实图、可复核素材和分享版导出。改用 macOS 原生渲染，制作时无需 Playwright 下载。
- [Apple 的 Spotlight 时间资料](https://developer.apple.com/documentation/coreservices/kmditemlastuseddate)说明最近使用字段。复用系统索引做候选，只展示记录覆盖。没有采用常驻使用监控或自动授予全盘访问。
- [OWASP 文件上传指南](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)。采纳尺寸与格式验证、服务端重新编码和举报入口。网站用范围选择和撤回凭证管理分享。
- [dayflow-review](https://skills.sh/wilbeibi/wilbeibi-skills/dayflow-review) 与 [macos-trace](https://skills.sh/kmgcc/macos-trace/macos-trace) 只作为目录相邻结果，未执行其代码。目标是选出值得公开推荐的应用，不采用采集完整桌面活动轨迹的流程。

本次实机验证含系统壁纸、较暗壁纸与纯色三个导出方向。默认取桌面壁纸加适度压暗。公共示例用纯色生成，保留原生软件图标。
