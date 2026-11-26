# Changelog

All notable changes to `@morsewayne/dsh-agy-acp` are documented in this file.

## [0.8.0] - 2026-11-27

### Added
- **Native Conversation-Panel Visualization for `agy_acp_tool`**: Registered a keyed DSH `tool.call.toolview` renderer (`mirror-tool-view.ts`, `mirror-tool-model.ts`, `mirror-presentation.ts`) reusing DSH Web's native UI primitives (`DisclosureRow`, `TerminalBlock`, `DiffBlock` + `diffTotals`, `ReadBlock`, `SearchBlock`, `WebBlock`, `Tag`, `TextShimmer`, and native icons). Replaces generic `agy_acp_tool · <runId>` rows for both live calls and previously recorded sessions with readable per-tool rows (Read with clickable file/line links, Edit/Write with inline `+N -M` diff stats, Terminal with cleaned output and exit-code badges, Grep/Glob search, Web search/fetch, `update_steps` checklists, and unwrapped IN/OUT cards).
- **ACP Diff & Command Exit Code Extraction**: Enhanced `mirror-tool.ts` to extract ACP standard `content: [{ type: 'diff', path, oldText, newText }]` changes into bounded `output.diffs` / `presentationMeta.diffs`, and parse exit codes from `Command exited with code N.` command headers.
- **Modular Console UI & MCP Policy Presets**: Refactored the Web Console into modular panels (`sessions-panel.ts`, `accounts-panel.ts`, `config-panel.ts`, `ui-primitives.ts`) with batch all-account egress checks, 3 one-click MCP tool policy presets (`balanced`, `dsh_first`, `minimal`), and unified DSH light/dark scoped styling.

### Changed
- **SSE Throttling & Tool Catalog Caching**: Detached `pool.on('status')` listeners automatically when no SSE clients are connected, throttled status broadcasts, and cached `collectMcpToolCatalog()` by policy key until `tools/change` or policy updates occur.

## [0.7.0] - 2026-11-27

### Added
- **Reverse MCP Tiered Tool Exposure & User Policy Model**: Introduced `mcp-tool-policy.ts` with 7 supplemental capability groups (`memory_core`, `delivery_skills` eager by default; `documents_office`, `goals_teams_workflow`, `memory_admin`, `media_system`, `other_plugins` on-demand by default) and 5 native-replacement groups (`subagents` replaced by DSH by default; `web_search`, `file_ops`, `shell_jobs`, `planning_schedule` native by default), plus per-tool `eager` / `lazy` / `off` overrides and backwards compatibility with `mcpExposeOverlappingTools`.
- **On-Demand Reverse MCP Meta-Tool Gateway (`dsh_discover_tools` / `dsh_call_tool`)**: Keeps eager `tools/list` declarations compact (~22–28 KB, well below `agy acp`'s 64 KiB cap) while preserving 100% full tool descriptions and parameter schemas for eager tools and allowing on-demand schema discovery and policy-enforced delegation (reusing DSH approvals and rejecting `off` or recursive calls) for lazy tools.
- **52 KB Schema Budget Safety Net**: Added `schema-budget.ts` as an automatic fallback fuse that only triggers with a warning if custom eager selections push serialized `tools/list` payloads beyond the safe 52 KB threshold.
- **Dynamic Host Bridge Routing & Live Tool Catalog**: Updated `prompt-builder.ts` to inject dynamic replacement guidance and a compact on-demand group index into `[Host Bridge Guidance]`, and wired `tools/change` tracking to expose live host tool catalogs (`mcpToolCatalog`) and per-tool byte estimates in `StatusSnapshot`.
- **Console UI Tool Policy Panel**: Added `mcp-tool-panel.ts` with a live eager-schema byte budget meter, supplemental vs. native-replacement group controls, searchable per-tool overrides, and a one-click action to apply policy changes to active ACP sessions.

## [0.6.0] - 2026-11-26

### Added
- **Native Reverse MCP Tool Delegation**: Delegated `dsh-tools` reverse MCP calls directly into DSH's native tool execution loop (native tool cards, DSH approvals, dynamic `ops_discover_tools` discovery, and multi-step continuation), with `AcpClient.pauseSessionTimer()` keeping the ACP prompt alive while awaiting long-running tools or human approval.
- **Configurable Auto Review Model & Cross-Provider Routing**: Added `autoReviewProvider`, `autoReviewModel`, and `autoReviewEffort` settings with Console UI controls and `GET /plugins/agy-acp/review-models?provider=...`. Supports forwarding DSH `purpose: 'auto-review'` requests via the `llm/stream` hook to any registered DSH provider/model (bypassing `agy acp` cold starts), or running on a selected Antigravity model with automatic lowest-effort downgrade when unspecified.

### Fixed
- **Generalized Continuation Step-Context Handling**: Replaced the hardcoded step-context allowlist in `detectContinuation` / `collectContinuationToolResults` with `isStepContextUserMessage`, ensuring system-injected step context from tools using `deferContext` never interrupts active reverse-MCP continuations.
- **Strict Reverse MCP Permission Identification**: Expanded `isDshReverseMcpToolCall` to recognize direct and `call_mcp_tool` reverse MCP frames while rejecting shell/edit/delete/move spoofing.

## [0.5.0] - 2026-11-26

### Added
- **Pure Anonymous Google Egress Probing**: Replaced third-party IP probes (`cloudflare.com` / `api.ip.sb`) in `DEFAULT_EGRESS_PROBES` with strictly anonymous, zero-credential Google endpoints (`HEAD https://aistudio.google.com/` + `POST https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`), ensuring split-tunnel proxies (e.g. Clash Verge) evaluate the exact Google routing policy without leaking credentials or requiring proxy config changes.
- **Native ACP `session/resume` & HTTP Reverse MCP**: Added capability-negotiated `session/resume` (with `session/load` fallback), native loopback HTTP reverse MCP transport (with per-session bearer auth and stdio fallback), and interactive native question delegation.
- **Direct Upstream Quota Reader & Hardened Process Tree Management**: Added direct quota API querying alongside CLI fallback, Linux cgroup/process-group tree termination (`process-tree.ts`), private per-process temporary directory isolation (`session-cleanup.ts`), bounded payload/attachment streaming (`payload-bounds.ts`), and `THIRD-PARTY-NOTICES.md`.
- **Hidden Turn Outcome Inspection**: Added read-only trajectory SQLite step inspection (`turn-outcome.ts`) plus a strict zero-token inline warning fallback (`evaluateInlineWarningFallback`) to classify `FAILED_PRECONDITION (400)`, `RESOURCE_EXHAUSTED (429)`, `TOS_VIOLATION`, and `INVALID_THINKING_SIGNATURE` even under read-only sandboxes (`bwrap --ro-bind / /`).

### Fixed
- **System prompt delivery stability**: Stopped injecting host system instructions via `_meta.antigravity.systemPrompt.append` (which could cause `agy acp` to hang on newer CLI builds) and standardized delivery via `<host_system_instructions>` prompt blocks.
- **`bwrap --tmpfs /tmp` TMPDIR isolation**: Detected private `/tmp` mounts in sandboxed `argv` so `TMPDIR`/`TMP`/`TEMP` stay at `/tmp` instead of pointing to a host-only directory invisible inside the sandbox.
- **Sticky proxy tunnel teardown on Geo 400**: Immediately invalidates the `agy acp` child process (and its pinned Go HTTP/2 connection) upon upstream 400 geo rejection while preserving `SessionIndex` for seamless `session/resume` on the next turn.
- **gRPC status decoding & prompt inactivity watchdog**: Matched canonical gRPC status names ahead of protobuf varint length prefixes, and restricted inactivity timer resets to active model/tool progress frames rather than metadata notifications.

## [0.4.2] - 2026-11-25

### Added
- **Workspace-Write Smart Auto-Allow with Risk Guardrails**: Automatically allows safe sandboxed commands and validated local workspace file operations under `workspace-write`, while continuing to escalate high-risk commands, out-of-bounds targets, and ambiguous inputs to DSH approval.
- **Per-Turn `stderr` Slicing**: `AcpClient` now tracks monotonic stderr offsets (`stderrOffset()` / `readStderrSince()`) so timeout and process-exit diagnostics include only output emitted during the failing request instead of stale warnings from earlier turns.
- **TOS Violation Quarantine Without Failover**: Recognizes `TOS_VIOLATION` / account-suspension errors with strict priority over quota/geo rules, immediately quarantines the affected account across all model families, halts automatic failover to prevent cascading bans, and surfaces quarantine alerts with manual recovery in Console UI and `/agy-acp status`.

### Fixed
- **Wrong cache-hit rate in DSH (0% instead of ~85%)**: Tool-mirror steps reported the whole context as uncached input, and the final step dropped the cache buckets when clamping the run-cumulative ACP usage. Each DSH step now reports the exact usage of the agy model calls behind it, tailed from agy's own per-call `transcript.jsonl` (`PLANNER_RESPONSE` records, under the account's HOME / `ANTIGRAVITY_APP_DATA_DIR`). Several calls in one step keep the latest prompt side (true context occupancy) and sum generation; a step without a new call reports nothing instead of re-billing.
- **Cache double subtraction**: agy's ACP `inputTokens` already excludes cached tokens, so `mapUsage` no longer subtracts the cache buckets from it (which zeroed uncached input and overstated hits in the console totals). Totals are derived when the reported one would make DSH reject the turn.
- **Fallback without a transcript** keeps the previous occupancy-based reporting, but the clamped final sample now scales cache buckets proportionally instead of dropping them.
- **Plugin reload disconnect attribution**: Reports plugin reload/unload explicitly when pool disposal terminates in-flight ACP turns.
- **Loopback reverse MCP immunity & `NO_PROXY` hardening**: Switched `bridge.mjs` to direct `node:http`/`node:https` requests (immune to `HTTP_PROXY`/`ALL_PROXY`/`NODE_USE_ENV_PROXY=1`), and automatically merges `127.0.0.1,localhost,::1` into `NO_PROXY`/`no_proxy` when proxy env vars are passed through account `env`.
- **Non-blocking credential slot release**: Replaced the up-to-2s synchronous busy-wait loop in `CredentialSlotLeaseManager` with an uncontended fast path + async contended retry and lazy non-spinning exit cleanup.

### Changed
- **Removed per-account `proxyUrl` / `hasProxy` config layer**: Simplified account configuration to rely on ambient host proxy/TUN or explicit `accounts[].env`, removing the unused `proxyUrl` field and UI badge.

## [0.4.1] - 2026-11-25

### Fixed
- **Context occupancy never shown in DSH**: The adapter only emitted a `usage` chunk when a whole ACP prompt finished, so tool-mirror steps carried no usage and DSH's token meter had no `pressureTokens`. Tool boundaries now report the live context occupancy, seeded from the session's last known `usage_update.used` since agy emits it only at prompt end.
- **Inflated context pressure**: ACP `session/prompt` usage is cumulative across every internal model call, so its cache-read bucket could exceed the context window. The final usage sample is now clamped to the live context occupancy when it would exceed it.

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
