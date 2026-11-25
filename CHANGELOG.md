# Changelog

All notable changes to `@morsewayne/dsh-agy-acp` are documented in this file.

## [0.4.0] - 2026-11-25

### Added
- **Native ACP `session/load` Continuity (Phase 5)**: Added `AcpClient.sessionLoad` and `0600` atomic `SessionIndex` (`~/.dsh/agy-acp/sessions.json`) with LRU/TTL bounds to natively restore conversation context and server-side Prompt Cache across idle sweeps and restarts, with automatic fallback to `session/new` + 24K digest.
- **Live Protocol Notification Sync (Phase 5)**: Consumed `config_option_update` and `session_info_update` over persistent sessions to synchronize model, reasoning effort, permission mode, and sanitized session titles in real time.
- **Reverse MCP Bridge Hardening & Observability (Phase 5)**: Added per-tool-call timeouts with `AbortSignal` cancellation (`-32001`), concurrency caps (`-32005`), and live `StatusSnapshot.mcpBridge` metrics in the Console UI.
- **Opt-In Quota-Aware Scheduling & Low-Quota Alerts (Phase 6)**: Added `quotaAwareScheduling` runtime setting (persisted in `config.json`), `mapQuotaGroupsToFamilies` mapping into `MultiAccountPool.updateQuota`, and `<=15%` low-quota warning banners on `AccountCard`.
- **Structured `/agy-acp` & `/agy-acp doctor` Diagnostics (Phase 6)**: Upgraded `/agy-acp` status overview and added `/agy-acp doctor` 5-step read-only, sandbox-confined self-check with full credential and IP redaction.

## [0.3.0] - 2026-11-25

### Added
- **Proxy-Consistent Egress Probe & GeoFence Guard (Phase 4)**: Implemented zero-dependency `EgressGuard` supporting HTTP `CONNECT` (Basic Auth), SOCKS5/SOCKS5H (`ATYP=0x03` remote DNS), `NO_PROXY`, and direct/TUN routing aligned with Go `agy`.
- **4-Path Local Circuit Breaker & Multi-Account Geo-Failover**: Guarded main chat (creation & long-lived session reuse), auxiliary prompts, model catalog discovery, and quota refresh against restricted egress regions (`HK`, `CN`, etc.) with zero upstream packets, instant `runtime-400` cache invalidation, `POST /plugins/agy-acp/accounts/egress/check`, and Console UI controls (`geoFenceMode`: `block` / `strict` / `warn` / `off`).

## [0.2.0] - 2026-11-25

### Added
- **Live Tool Mirroring & Full Native Cards (Phase 1)**: Incremental `toolCallId` merging, immediate `in_progress` tool card emission, concurrent tool batching, `terminal`/`diff`/`read`/`search`/`web`/`generic` presentations, `options.system` forwarding, read-only `options.purpose` auxiliary calls, and 24K character-budgeted `<prior_conversation_digest>`.
- **Approval Experience, Symlink Escape Prevention & Crash Recovery (Phase 2)**: Human-readable Chinese approval summaries (removing silent 8KB rejection), `realpathSync` workspace path validation, `sanitizeDiagnosticText` credential redaction, typed ACP errors (`AcpRpcError` / `AcpTimeoutError` / `AcpProcessExitError`), interrupted approval / reasoning exit recovery, and deferred safe permission switches.
- **Atomic Config Persistence & DSH-Themed Console UI (Phase 3)**: Added `0600` atomic `ConfigStore` (`~/.dsh/agy-acp/config.json`) with reset, `POST /plugins/agy-acp/models/refresh` generation isolation, singleton browser SSE `StatusStore`, and DSH `--dsw-alias-*` light/dark theme adaptation.

## [0.1.0] - 2026-11-24

### Added
- Initial persistent `agy acp` JSON-RPC 2.0 provider adapter, DSH session-owned permission confinement, multi-account credential slot leases, account quota observation, and SSE status stream.
