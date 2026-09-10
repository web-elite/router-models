# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - 2026-09-10

### Added

- Register OpenAI-compatible providers for the VS Code Chat model picker
- Automatic model discovery via `/v1/models`
- Secure API key storage using VS Code SecretStorage
- Provider removal with confirmation
- Model list caching in `globalState`
- Commands: Add Provider, Remove Provider, Refresh Models
- Settings: `requestTimeoutMs`, `defaultTemperature`
