# Router Models — VS Code Extension

Add any **OpenAI-compatible API provider** (OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio, …) to the built-in **VS Code Chat / Copilot model picker**.

Powered by the [`languageModelChatProviders`](https://code.visualstudio.com/updates/v1_104) contribution point (VS Code ≥ 1.104).

## Features

- 🔌 Register any OpenAI-compatible endpoint as a chat model provider in VS Code
- 📦 Automatically discovers models from the provider's `/v1/models` endpoint
- 🔐 API keys stored securely in VS Code **SecretStorage** (never in plain settings)
- 💾 Model list cached in `globalState` — available instantly after restart
- 🗑️ Add / remove providers through a simple UI flow
- ⏱️ Configurable request timeout and default temperature

## Getting Started

1. Install the extension.
2. Open the Command Palette (`Ctrl+Shift+P`) and run **Router Models: Add Provider**.
3. Enter:
   - A provider **name** (e.g. `OpenAI`, `OpenRouter`)
   - The **base URL** (e.g. `https://api.openai.com/v1`)
   - Your **API key**
4. Open the Copilot Chat model picker — models from your provider appear under the **Router Models** vendor.

## Commands

| Command | Description |
| --- | --- |
| `Router Models: Add Provider` | Register a new OpenAI-compatible provider |
| `Router Models: Remove Provider` | Remove a configured provider (and its key) |
| `Router Models: Refresh Models` | Re-fetch the model list from all providers |

## Extension Settings

| Setting | Default | Description |
| --- | --- | --- |
| `routerModels.requestTimeoutMs` | `30000` | Timeout (ms) for requests made to providers |
| `routerModels.defaultTemperature` | `0.2` | Default temperature for chat completions |

## Supported Endpoints

Any service exposing the OpenAI Chat Completions API works out of the box:

- OpenAI — `https://api.openai.com/v1`
- OpenRouter — `https://openrouter.ai/api/v1`
- Groq — `https://api.groq.com/openai/v1`
- Together AI — `https://api.together.xyz/v1`
- Ollama — `http://localhost:11434/v1`
- LM Studio — `http://localhost:1234/v1`

## Building from Source

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host, or package a VSIX:

```bash
npx @vscode/vsce package
```

## License

[MIT](LICENSE) © Web Elite
