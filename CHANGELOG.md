# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.3] - 2026-09-11

### Added

- Multi-key management: enter one or many API keys per provider (one per
  line, comma or space separated) with round-robin key rotation
- Auto-fallback: requests are handed to the next key immediately on
  429 / 500 / 502 / 503 / 504 or connection errors
- Smart cooldown: 429 puts the key to rest for a configurable time
  (per provider, default 60s); a `Retry-After` header from the provider
  overrides the configured value
- 401 / 403 responses mark a key as burned (×) until it is replaced
- Live key monitor in the status bar:
  `Router: <model> ∣ Keys: N active ∣ Total: T ✓R 429:C ×B`
- Status bar menu with per-provider key details, remaining cooldown
  times and a one-click "Reset Cooldowns" action
- Automatic retry (up to `routerModels.maxRetries`, default 3) when the
  model returns an empty stream ("Sorry, no response was returned") or
  the stream is cut before any output
- Reasoning / thinking output (`reasoning_content`, `reasoning`,
  `thinking`, `thought`) is surfaced to the user instead of being
  dropped
- Automatic favicon detection from the provider's base URL (manual icon
  URL still wins)

### Fixed

- Tool calling end to end: VS Code tool calls and tool results are now
  converted to/from the OpenAI wire format, so Copilot Chat no longer
  ends the turn silently when the model wants to call a tool
- Streamed tool calls are accumulated across fragments and reported as
  `LanguageModelToolCallPart` (including fragmented JSON arguments)
- Routers that ignore `stream: true` and answer with a plain JSON
  completion are handled correctly
- The request timeout now only guards the handshake; long generations
  are no longer cut off mid-stream
- `Retry-After` dates / offsets parsed per the HTTP standard

## [0.0.1] - 2026-09-10

### Added

- Register OpenAI-compatible providers for the VS Code Chat model picker
- Automatic model discovery via `/v1/models`
- Secure API key storage using VS Code SecretStorage
- Provider removal with confirmation
- Model list caching in `globalState`
- Commands: Add Provider, Remove Provider, Refresh Models
- Settings: `requestTimeoutMs`, `defaultTemperature`
