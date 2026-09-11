# Router Models — VS Code Extension

Add any **OpenAI-compatible API provider** (OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio, …) to the built-in **VS Code Chat / Copilot model picker**.

Powered by the [`languageModelChatProviders`](https://code.visualstudio.com/updates/v1_104) contribution point (VS Code ≥ 1.104).

## Features

- 🔌 Register any OpenAI-compatible endpoint as a chat model provider in VS Code
- 📦 Automatically discovers models from the provider's `/v1/models` endpoint
- 🔐 API keys stored securely in VS Code **SecretStorage** (never in plain settings)
- 🔑 **Multi-key support** — enter several keys per provider; requests rotate
  round-robin and automatically fall back to the next key on `429` /
  `500 / 502 / 503 / 504` / connection errors
- ❄️ **Smart cooldown** — a rate-limited key rests for a configurable time
  (per provider, default 60 s); a `Retry-After` header from the provider wins.
  `401 / 403` burn a key (×) until it is replaced
- 📊 **Live key monitor in the status bar** —
  `Router: <model> ∣ Keys: N active ∣ Total: T ✓R 429:C ×B` — click for a menu
  with per-key details, remaining cooldowns and a *Reset Cooldowns* action
- 🔁 **Auto-retry on empty responses** — empty / cut streams (e.g. Gemini's
  `delta: {}` endings) are retried automatically instead of showing
  *"Sorry, no response was returned"*
- 🧠 **Reasoning passthrough** — `reasoning_content` / `reasoning` / `thinking`
  / `thought` output is surfaced instead of being dropped
- 🛠️ **Full tool-calling support** — VS Code tool calls and tool results are
  converted end to end, so Copilot Chat agents keep working
- 🖼️ **Automatic favicon** — the provider's icon is fetched from its host
  automatically (manual icon URL still wins)
- 📥 **JSON import** — pick any JSON export containing `providerConnections`
  (searched up to 4 levels deep); connections sharing a
  `providerSpecificData.prefix` are merged into ONE provider with all of
  their API keys (7 keys → one provider with 7 rotating keys), the prefix
  becomes the provider id and `nodeName` its name, and keys that are
  already known are skipped
- 💾 Model list cached in `globalState` — available instantly after restart
- 🗑️ Add / remove providers through a simple UI flow
- ⏱️ Configurable request timeout and default temperature

## Getting Started

1. Install the extension.
2. Open the Command Palette (`Ctrl+Shift+P`) and run **Router Models: Add Provider**.
3. Enter:
   - A provider **name** (e.g. `OpenAI`, `OpenRouter`)
   - The **base URL** (e.g. `https://api.openai.com/v1`)
   - One or more **API keys** (one per line, or comma separated) — optional
   - An optional **cooldown** in seconds used after a `429`
4. Open the Copilot Chat model picker — models from your provider appear under the **Router Models** vendor.

## Commands

| Command | Description |
| --- | --- |
| `Router Models: Add Provider` | Register a new OpenAI-compatible provider |
| `Router Models: Import Providers from JSON` | Pick a JSON file — `providerConnections` entries (found up to 4 levels deep) are imported one by one with their API keys |
| `Router Models: Remove Provider` | Remove a configured provider (and its keys) |
| `Router Models: Refresh Models` | Re-fetch the model list from all providers |
| `Router Models: Show Key Status` | Open the key / cooldown monitor menu |
| `Router Models: Reset Key Cooldowns` | Instantly clear all 429 cooldowns |

## Extension Settings

| Setting | Default | Description |
| --- | --- | --- |
| `routerModels.requestTimeoutMs` | `30000` | Timeout (ms) for the request handshake (streaming is never cut off) |
| `routerModels.defaultTemperature` | `0.2` | Default temperature for chat completions |
| `routerModels.defaultCooldownSeconds` | `60` | Cooldown a key rests after a `429` (per-provider override available) |
| `routerModels.maxRetries` | `3` | Extra attempts with the next key on `429`/server errors/empty responses |
| `routerModels.autoFavicon` | `true` | Auto-detect the provider favicon from its base URL |
| `routerModels.showReasoning` | `true` | Surface reasoning / thinking output as visible text |

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
