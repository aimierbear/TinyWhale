# TinyWhale

[English](README.md) | 中文

TinyWhale 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的独立桌面向 fork。运行时仍采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

本项目**与 DeepSeek 无隶属、背书或赞助关系**。"DeepSeek" 是其权利人的商标。内部 npm 包仍使用 `@deepseek-ai/*` scope，以便跟踪上游；对外产品名是 TinyWhale。

## 开发者预览

该 harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 安装打包应用

在 Apple Silicon Mac 上，从 [GitHub Releases](https://github.com/aimierbear/TinyWhale/releases) 下载 DMG，把 TinyWhale 拖进「应用程序」，再打开。安装包自带 Node、pnpm、Git 和 harness，不需要检出或 Homebrew。这是开发者预览构建：在签过名的发行版出来之前，它未经公证。

## 从源码运行桌面应用

安装 `Node.js` 后，在本仓库中执行：

```sh
cd desktop
npm install
npm start
```

若 `http://127.0.0.1:3080` 已在提供 Web UI，Electron 壳会直接接入；否则它会启动 `dsh web` 并打开窗口。详见 [desktop/README.md](desktop/README.md)。

## 运行 Web UI

### 通过 `npm` 运行

```sh
npx @deepseek-ai/dsh web
```

该命令会启动 Web UI，默认地址为 `http://127.0.0.1:3080`。详见 [Web UI 指南](docs/user/guide/index.md)。

### 从源码运行

```sh
git clone https://github.com/aimierbear/TinyWhale.git
cd TinyWhale
pnpm install
pnpm run build
pnpm dsh web
```

## 社区与支持

- TinyWhale 相关问题请提到 [本仓库 Issues](https://github.com/aimierbear/TinyWhale/issues)。
- 上游 harness 讨论仍在 [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。本 fork 的额外约定见 [TINYWHALE.md](TINYWHALE.md)。

## 许可证

[MIT](LICENSE)

上游版权予以保留。归属声明见 [NOTICE](NOTICE)。第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
