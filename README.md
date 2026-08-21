# TinyWhale

English | [中文](README.zh.md)

TinyWhale is an independent desktop-oriented fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). The runtime still uses a plugin architecture powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

This project is **not affiliated with, endorsed by, or sponsored by DeepSeek**. "DeepSeek" is a trademark of its owner. Internal packages still use the `@deepseek-ai/*` scope so the fork can track upstream; the public product name is TinyWhale.

## Developer preview

The harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Install the packaged app

On Apple Silicon Macs, download the DMG from [GitHub Releases](https://github.com/aimierbear/TinyWhale/releases), drag TinyWhale into Applications, then open it. The install vendors Node, pnpm, Git, and the harness. You do not need a checkout or Homebrew. This is a developer-preview build: it is not notarized until a signed release is published.

## Run the desktop app from source

Install `Node.js`, then from this repository:

```sh
cd desktop
npm install
npm start
```

The Electron shell attaches to `http://127.0.0.1:3080` when that address already serves the Web UI; otherwise it starts `dsh web` and opens the window. See [desktop/README.md](desktop/README.md).

<a id="run"></a>

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

<a id="run-from-source"></a>

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/aimierbear/TinyWhale.git
cd TinyWhale
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Community and support

- Open TinyWhale-specific issues on [this repository](https://github.com/aimierbear/TinyWhale/issues).
- Upstream harness discussion remains at [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md). Fork-specific layout is in [TINYWHALE.md](TINYWHALE.md).

## License

[MIT](LICENSE)

Upstream copyright is retained. Attribution is in [NOTICE](NOTICE). Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
