import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { AcpToolCallUpdate, AcpUsage } from '../acp/protocol.ts'
import {
  MIRROR_TOOL_NAME,
  PROVIDER_ID,
  WRAPPER_TOOL_NAME,
  type PluginConfig,
} from '../common/types.ts'
import { isQuotaOrRateLimitError } from '../runtime/account-pool.ts'
import type { AcpSessionPool } from '../runtime/session-pool.ts'
import { buildPromptBlocks } from './prompt-builder.ts'
import {
  decodeMirrorCallId,
  encodeMirrorCallId,
  type AcpRunRecording,
  type AcpRunStore,
} from './run-store.ts'

export interface AcpAdapterDeps {
  getConfig: () => PluginConfig
  pool: AcpSessionPool
  runs: AcpRunStore
  log?: (msg: string) => void
}

export class AcpAdapter extends LlmAdapter {
  constructor(private readonly deps: AcpAdapterDeps) {
    super()
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return { id: PROVIDER_ID, name: 'Antigravity (ACP)' }
  }

  override async listModels(_provider: string): Promise<LlmModelInfo[]> {
    const models = await this.deps.pool.refreshModels()
    return models.map((m) => ({
      provider: PROVIDER_ID, id: m.value, name: m.name, inputModalities: ['text', 'image'],
    }))
  }

  override async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const models = await this.deps.pool.refreshModels().catch(() => [])
    const matched = models.find((m) => m.value === model)
    const contextWindow = model.startsWith('claude') ? 200_000 : 1_048_576
    return {
      provider: PROVIDER_ID,
      id: model,
      name: matched?.name ?? model,
      inputModalities: ['text', 'image'],
      context: { contextWindow },
      ...(matched && matched.efforts.length > 0
        ? {
            reasoning: {
              efforts: matched.efforts.map((e) => ({
                id: e as never,
                name: e.toUpperCase(),
              })),
            },
          }
        : {}),
    }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    model: LlmResolvedModelInfo
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }> {
    if (signal?.aborted) throw signal.reason ?? new LlmError('aborted', 'ABORTED')
    const modelInfo = await this.resolveModel(provider, model)
    return {
      model: modelInfo,
      stream: (options) => this.stream({ ...options, signal: options.signal ?? signal }),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const cfg = this.deps.getConfig()
    if (!cfg.enabled) {
      throw new LlmError('dsh-agy-acp is disabled by config', 'PROVIDER_DISABLED')
    }

    const sessionKey = options.sessionId
    if (!sessionKey || options.purpose) throw new Error('Antigravity requires an identified DSH conversation turn; auxiliary calls cannot execute native tools')
    const hasMirrorTool = Boolean(options.tools?.some((t) => t.name === MIRROR_TOOL_NAME))
    const isCodeMode = Boolean(options.tools?.some((t) => t.name === WRAPPER_TOOL_NAME)) && !hasMirrorTool
    const cutOnTool = hasMirrorTool || isCodeMode

    // 1. Continuation span: DSH just executed `agy_acp_tool` and is resuming the same ACP turn.
    const continuation = detectContinuation(options.messages)
    if (continuation) {
      const rec = this.deps.runs.get(continuation.runId)
      if (rec && rec.owner === sessionKey) {
        const onContAbort = (): void => {
          rec.requestCancel()
        }
        options.signal?.addEventListener('abort', onContAbort, { once: true })
        try {
          yield* this.driveRecording(rec, continuation.itemIndex + 1, cutOnTool, isCodeMode, options.signal)
        } finally {
          options.signal?.removeEventListener('abort', onContAbort)
        }
        return
      }
    }

    // 2. Fresh turn over persistent ACP session (with automatic 429/quota failover).
    const cwd = this.deps.pool.policy(sessionKey).workspaceRoot
    const requestedModel = options.model || cfg.defaultModel || ''
    const triedAccounts = new Set<string>()
    const maxAttempts = Math.max(1, cfg.accounts.filter((a) => a.enabled !== false).length || 1)

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { client, session, created } = await this.deps.pool.getOrCreateSession(
        sessionKey,
        cwd,
        requestedModel,
        triedAccounts.size > 0 ? triedAccounts : undefined,
      )
      triedAccounts.add(session.accountId)

      const targetModel = requestedModel || session.currentModel
      const targetEffort =
        options.reasoningEffort !== undefined ? String(options.reasoningEffort) : cfg.defaultEffort || undefined
      const policy = this.deps.pool.policy(sessionKey)
      const nativeAuto = session.configOptions.find(o => o.id === 'mode')?.options?.some(o => 'value' in o ? o.value === 'auto' : o.options.some(v => v.value === 'auto'))
      const targetMode = policy.preset === 'auto' && policy.mode === 'danger-full-access' && nativeAuto ? 'auto' : 'default'

      await this.deps.pool.syncSessionOptions(client, session, {
        model: targetModel,
        effort: targetEffort,
        mode: targetMode,
      })

      const promptBlocks = buildPromptBlocks(options.messages, created)
      if (session.currentMode !== targetMode) throw new Error(`Antigravity did not accept permission mode ${targetMode}`)
      const turn = this.deps.pool.beginPrompt(session, options.signal)
      const rec = this.deps.runs.create(sessionKey)
      rec.setCancelHandler(() => {
        turn.cancel()
        client.sessionCancel(session.acpSessionId)
      })

      const unsubscribe = client.onSessionUpdate(session.acpSessionId, (update) => {
        rec.pushUpdate(update)
        if (update.sessionUpdate === 'usage_update' && typeof update.used === 'number') {
          this.deps.pool.recordContextUsage(sessionKey, update.used, typeof update.size === 'number' ? update.size : 0)
        }
      })

      const onAbort = (): void => {
        rec.requestCancel()
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      // Run `session/prompt` in background so the recording can span multiple DSH tool-mirror loops.
      void client
        .sessionPrompt({ sessionId: session.acpSessionId, prompt: promptBlocks }, cfg.requestTimeoutMs)
        .then((res) => {
          this.deps.pool.reportAccountSuccess(session.accountId, targetModel)
          this.deps.pool.recordTurnUsage(res.usage)
          rec.finish(res.stopReason, res.usage)
        })
        .catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err))
          this.deps.pool.reportAccountFailure(session.accountId, targetModel, error)
          // A timed-out RPC may still be running on the peer. Never reuse that process.
          if (this.deps.pool.owns(session)) this.deps.pool.invalidate(sessionKey)
          rec.fail(error)
        })
        .finally(() => {
          turn.finish()
          unsubscribe()
          rec.setCancelHandler(null)
          options.signal?.removeEventListener('abort', onAbort)
        })

      // Peek first item before yielding so quota/429 errors before any output can seamlessly fail over.
      const firstItem = await rec.waitFor(0, options.signal)
      if (
        firstItem?.kind === 'error' &&
        isQuotaOrRateLimitError(firstItem.error) &&
        attempt + 1 < maxAttempts &&
        !options.signal?.aborted
      ) {
        this.deps.log?.(
          `account "${session.accountId}" hit quota/rate-limit on "${targetModel}", failing over (attempt ${attempt + 2}/${maxAttempts})`,
        )
        await this.deps.pool.closeSession(sessionKey)
        continue
      }

      yield* this.driveRecording(rec, 0, cutOnTool, isCodeMode, options.signal)
      return
    }
  }

  private async *driveRecording(
    rec: AcpRunRecording,
    startIndex: number,
    cutOnTool: boolean,
    isCodeMode: boolean,
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    let idx = startIndex
    let blockIdx = 0
    let openType: 'text' | 'reasoning' | null = null
    let openAcc = ''

    const closeOpenBlock = (): StreamChunk | null => {
      if (openType === null) return null
      const chunk: StreamChunk =
        openType === 'text'
          ? { type: 'block-end', index: blockIdx, block: { type: 'text', text: openAcc } }
          : { type: 'block-end', index: blockIdx, block: { type: 'reasoning', text: openAcc } }
      blockIdx++
      openType = null
      openAcc = ''
      return chunk
    }

    while (true) {
      if (signal?.aborted) {
        const closed = closeOpenBlock()
        if (closed) yield closed
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted by caller' } },
        }
        return
      }

      const item = await rec.waitFor(idx, signal)
      if (signal?.aborted) {
        const closed = closeOpenBlock()
        if (closed) yield closed
        yield {
          type: 'finish',
          reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted by caller' } },
        }
        return
      }
      if (!item) {
        const closed = closeOpenBlock()
        if (closed) yield closed
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      if (item.kind === 'error') {
        const closed = closeOpenBlock()
        if (closed) yield closed
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { code: 'ACP_ERROR', message: item.error.message },
          },
        }
        return
      }

      if (item.kind === 'done') {
        const closed = closeOpenBlock()
        if (closed) yield closed
        if (item.usage) {
          yield { type: 'usage', usage: mapUsage(item.usage) }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }

      const u = item.update
      if (u.sessionUpdate === 'agent_thought_chunk' && u.content && typeof u.content === 'object' && 'text' in u.content) {
        const delta = String(u.content.text ?? '')
        if (delta) {
          if (openType !== 'reasoning') {
            const closed = closeOpenBlock()
            if (closed) yield closed
            openType = 'reasoning'
            openAcc = ''
            yield { type: 'block-start', index: blockIdx, blockType: 'reasoning' }
          }
          openAcc += delta
          yield { type: 'reasoning-delta', index: blockIdx, text: delta }
        }
      } else if (u.sessionUpdate === 'agent_message_chunk' && u.content && typeof u.content === 'object' && 'text' in u.content) {
        const delta = String(u.content.text ?? '')
        if (delta) {
          if (openType !== 'text') {
            const closed = closeOpenBlock()
            if (closed) yield closed
            openType = 'text'
            openAcc = ''
            yield { type: 'block-start', index: blockIdx, blockType: 'text' }
          }
          openAcc += delta
          yield { type: 'text-delta', index: blockIdx, text: delta }
        }
      } else if (
        cutOnTool &&
        (u.sessionUpdate === 'tool_call_update' || u.sessionUpdate === 'tool_call') &&
        (u.status === 'completed' || u.status === 'failed')
      ) {
        const closed = closeOpenBlock()
        if (closed) yield closed

        const tc = u as AcpToolCallUpdate
        const toolName = isCodeMode ? WRAPPER_TOOL_NAME : MIRROR_TOOL_NAME
        const callId = encodeMirrorCallId(rec.id, idx) as ToolCallId
        const argsJson = isCodeMode
          ? JSON.stringify({
              code: `await tools[${JSON.stringify(MIRROR_TOOL_NAME)}](${JSON.stringify({
                run: rec.id,
                step: idx,
                tool: tc.name ?? 'tool',
                ...(tc.title ? { title: tc.title } : {}),
                ...(tc.kind ? { kind: tc.kind } : {}),
              })})`,
            })
          : JSON.stringify({
              run: rec.id,
              step: idx,
              tool: tc.name ?? 'tool',
              ...(tc.title ? { title: tc.title } : {}),
              ...(tc.kind ? { kind: tc.kind } : {}),
              input: tc.rawInput ?? tc.args,
            })

        yield { type: 'block-start', index: blockIdx, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: blockIdx,
          block: {
            type: 'tool-call',
            id: callId,
            name: toolName,
            arguments: argsJson,
          },
        }
        yield {
          type: 'usage',
          usage: { inputTokens: rec.lastContextUsed, outputTokens: 0 },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }

      idx++
    }
  }
}

function mapUsage(raw: AcpUsage): TokenUsage {
  const inputTotal = raw.inputTokens ?? 0
  const cachedRead = raw.cachedReadTokens ?? 0
  const cachedWrite = raw.cachedWriteTokens ?? 0
  return {
    inputTokens: Math.max(0, inputTotal - cachedRead),
    outputTokens: raw.outputTokens ?? 0,
    ...(raw.totalTokens !== undefined ? { totalTokens: raw.totalTokens } : {}),
    ...(cachedRead > 0 ? { cacheReadTokens: cachedRead } : {}),
    ...(cachedWrite > 0 ? { cacheWriteTokens: cachedWrite } : {}),
    ...(raw.thoughtTokens !== undefined && raw.thoughtTokens > 0
      ? { reasoningTokens: raw.thoughtTokens }
      : {}),
  }
}

function detectContinuation(messages: readonly Message[]): { runId: string; itemIndex: number } | null {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') return null
  for (let i = last.content.length - 1; i >= 0; i--) {
    const block = last.content[i]
    if (block?.type === 'tool-result' && typeof block.toolCallId === 'string') {
      const parsed = decodeMirrorCallId(block.toolCallId)
      if (parsed) return parsed
    }
  }
  return null
}
