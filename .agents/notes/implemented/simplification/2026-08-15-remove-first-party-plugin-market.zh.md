# Agent Note: 移除自研插件市场

Status: implemented

[English](2026-08-15-remove-first-party-plugin-market.md) | 中文

## 问题

TinyWhale 曾以两个 workspace 包加上 Web Settings 装配交付自研插件市场：Host Remote 负责扫描 GitHub 源码、安装进 profile，并存储自检与忽略标记；Settings tab 则投影一份维护者审核过的 `dsh-plugin` 话题快照。这套界面重复了社区发现能力，却没有成为产品选定的市场，同时还多出一条转发 Host 事件、一道目录数据门禁，以及每个 web 组装都必须携带的两个包。

最初的动机成立：若产品提供安装，只通过 GitHub 浏览社区插件并不安全；目录若静默跟踪上游，也会继承未经审核的变更。这些约束对未来任何自研市场仍然适用，但不足以继续保留这套未再使用的树内实现。

## 决策

彻底删除自研市场：`@deepseek-ai/dsh-host-plugin-market`、`@deepseek-ai/dsh-client-ui-settings-plugin-market`、它们的测试、快照与已验证目录数据、生成与校验脚本、`verify-plugin-market-data` 门禁、`plugin-market/scan-progress` 转发事件，以及两条 `dsh-web-app` 配置行。不保留别名、空 Remote 或空 Settings tab。

设置 → 插件仍保留既有的配置与清单 tab。安装进 profile 的社区市场插件不在本次变更范围内。本说明合并并取代原先记录树内市场的架构笔记。

自研市场只有作为新决策、带着自己的包与装配重新引入。遗留的 settings 命名空间 `plugin-market-self-verified` 与 `plugin-market-ignored` 是惰性用户数据；本次变更不迁移、也不删除它们。

## 考虑过的替代方案

- **只禁用两条 `dsh-web-app` 配置行，保留这两个包。** 不予采纳：未使用的包、转发事件和目录门禁仍会参与编译、安装并持续占用维护成本。
- **保留 Host Remote 供其他界面使用。** 不予采纳：已无任何界面调用 `pluginMarket`，没有消费方的 Remote 不是产品接缝。
- **把该 tab 换成指向外部目录的链接。** 不予采纳：那是另一个产品决策；本次变更只删除未再使用的自研实现。

## 后果

Web Settings 不再贡献自研的「插件市场」tab。`pluginMarket` 不再是 Remote 命名空间，`plugin-market/scan-progress` 也不再是转发的 Host 事件。对 `@deepseek-ai/dsh-host-plugin-market` 与 `@deepseek-ai/dsh-client-ui-settings-plugin-market` 的导入不再可解析。

仓库不再拥有维护者审核的 `dsh-plugin` 快照，也不再拥有针对社区插件源码的静态扫描器。插件清单与插件配置保持不变。已安装的第三方市场插件不属于本次删除范围。

## 验证

workspace 包发现、web-app 补丁列表、Remote 组装与转发事件名单中均不再包含自研市场包、配置行、命名空间或事件。聚焦的 remotes 与 apiproxy 测试仍然通过。文档检查及生成目录门禁拒绝对已移除包的活跃引用。
