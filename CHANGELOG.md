# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.8] - 2026-09-19

### Added

- The provider list now carries a revision timestamp that syncs
  alongside it. When the two machines have both edited the provider
  list, the newest write wins — the other machine re-reads the
  revision on load / `Reload from Settings Sync` and repersists its
  own newer copy so it is not silently overwritten by a stale
  cloud snapshot

- Free model detector: a curated free-models registry shipped with
  the extension is matched against each provider by its base URL's
  domain, so models are flagged as free automatically for any
  provider you add

## [0.1.7] - 2026-09-19

### Added

- Free model detection from the extension's own curated source
  (`routerModels.freeModelsEnabled`, off by default) plus the
  periodic re-download of that list
  (`routerModels.freeModelsRefreshHours`, default 24 h)
- An in-sidebar banner that surfaces free AI providers
- `Router Models: Detect Free Models` command to force a refresh

### Fixed

- The provider name is now shown in the Copilot model picker

## [0.1.6] - 2026-09-19

### Added

- The provider name is shown next to every model in the Copilot
  model picker
- Automatic retry on Copilot / provider errors, with exponential
  backoff, so transient blips (rate limits, 5xx, empty responses,
  dropped connections) no longer stop unattended runs

## [0.1.5] - 2026-09-16

### Added

- Favicon resolution from the main domain when the provider host has
  no favicon of its own
- Reworked sidebar styling for a cleaner look

### Fixed

- Provider icon rendering

## [0.1.2] - 2026-09-13

### Fixed

- Management command structure and the sidebar icon field in
  `package.json` so the extension activates and its view renders
  correctly

### Changed

- README header links and star-callout formatting

## [0.1.0] - 2026-09-13

### Changed

- Bumped the extension to the 0.1.x series (stable rename from the
  0.0.x pre-release line)

## [0.0.9] - 2026-09-13

### Added

- Provider JSON export: `Router Models: Export Providers to JSON`
  (also a ⤒ button in the sidebar header) writes every provider —
  endpoint, icon, cooldown, models, manual entries and "free" tags,
  plus the include/exclude patterns — to a JSON file. API keys can be
  included (opt-in, written as plain text — keep the file private) or
  left out
- Provider JSON import of the extension's own export format:
  `Router Models: Import Providers from JSON` detects
  `router-models-export` files and offers **Merge** (adds new
  providers, merges keys and models, skips duplicates) or **Replace**
  (confirmed full restore, including the exported include/exclude
  patterns); exports written by a newer version are imported
  best-effort
- Settings Sync support: the provider list and the model cache
  (manual models and "free" tags included) sync across machines
  through VS Code Settings Sync (GitHub / Microsoft account). The new
  `routerModels.syncApiKeys` setting (default `false`) additionally
  mirrors the API keys into the synced state — key reads fall back to
  the mirror and heal the local secure storage, and
  `Router Models: Reload from Settings Sync` (or simply opening the
  sidebar) picks up changes, since VS Code fires no event for synced
  global state

## [0.0.8] - 2026-09-12

### Added

- Free model tagging: every model in the sidebar has a **+ free**
  toggle — tagged models show a green **✓ free** badge and are listed
  as `Name (free)` in the Copilot model picker, so typing "free" in
  the picker's search box finds all free models across every
  provider. Models whose id or name already contains "free" (e.g.
  OpenRouter's `:free` variants) are tagged automatically; the flag
  survives model refreshes, and the sidebar **+ Model** form (plus the
  `Router Models: Add Model Manually` command) offers a free option
  too

## [0.0.7] - 2026-09-12

### Changed

- Logo color

### Added

- README updates

## [0.0.6] - 2026-09-11

### Changed

- Prepared the 0.0.6 marketplace release

## [0.0.5] - 2026-09-11

### Fixed

- Robust file decoding on JSON import: BOM and UTF-16 encoded files
  are now read correctly
- File sizes reported in import / export messages are now accurate

## [0.0.4] - 2026-09-11

### Added

- JSON import: `Router Models: Import Providers from JSON` (also a ⇩
  button in the sidebar header and in the empty state) opens a file
  picker; the chosen file is searched up to 4 levels deep for
  `providerConnections` lists and the connections are imported with
  their API keys stored securely in SecretStorage
- Provider grouping: connections sharing a
  `providerSpecificData.prefix` are merged into ONE provider — 7
  connections with the same prefix become a single provider with 7
  rotating API keys. The prefix becomes the provider id and
  `providerSpecificData.nodeName` its display name
- Field mapping per group: `providerSpecificData.baseUrl` is used as
  the endpoint and all `apiKey` values of the group are stored
  (deduplicated) as the provider's key list, then models are
  discovered automatically as with a manually added provider
- Duplicate protection: keys that are already stored under an existing
  provider are skipped; a group whose id/name AND endpoint match an
  existing provider gets its new keys appended instead of creating a
  duplicate; connections without an API key or a base URL are reported
  instead of failing silently; clashing names get a numeric suffix

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
