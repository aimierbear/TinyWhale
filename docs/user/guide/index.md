# Use the Web UI

English | [中文](index.zh.md)

On Apple Silicon Macs you can skip the command line: download the DMG from [GitHub Releases](https://github.com/aimierbear/TinyWhale/releases), drag TinyWhale into Applications, then open it. If macOS says the developer cannot be verified, open **System Settings → Privacy & Security** and choose **Open Anyway**. Then continue from **Configure a model** below.

To start from source instead, use the [root README](../../../README.md#run-the-web-ui); the command prints its URL. This guide begins after the window or server is running. The `dsh` process uses its invoking directory as the default filesystem location, but a fresh Web UI has no selected workspace until you add one.

## Configure a model

Open **Settings → Models**, enter a DeepSeek API key, and save it. The model route becomes usable immediately without restarting the server.

The [model configuration guide](./providers.md) covers other providers and custom OpenAI-compatible endpoints.

## Choose a workspace

Click **Choose workspace**, add the project directory where you started `dsh`, and select it. The session composer remains unavailable until a workspace is selected.

## Run a task

Start a session and send:

> Summarize this repository and identify its main packages.

The agent can read and edit workspace files, run commands, delegate work, and maintain a plan. The Web UI asks before operations that require approval under the active permission policy.

## Continue

- [Configure models](./providers.md)
- [Use the Python SDK](./python-sdk.md)
- [Use other CLI modes](../../../apps/cli/README.md)
- [Develop a plugin](../develop/basic/)
