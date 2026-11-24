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

const FALLBACK_MODELS: LlmModelInfo[] = [
  { provider: PROVIDER_ID, id: 'gemini-4-neon', name: 'Gemini 4 Neon', inputModalities: ['text', 'image'] },
  { provider: PROVIDER_ID, id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', inputModalities: ['text', 'image'] },
  { provider: PROVIDER_ID, id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', inputModalities: ['text', 'image'] },
  { provider: PROVIDER_ID, id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', inputModalities: ['text', 'image'] },
  { provider: PROVIDER_ID, id: 'claude-opus-5-5', name: 'Claude Opus 5.5', inputModalities: ['text', 'image'] },
  { provider: PROVIDER_ID, id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', inputModalities: ['text', 'image'] },
]

export class AcpAdapter extends LlmAdapter {
  constructor(private readonly deps: AcpAdapterDeps) {
    super()
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return { id: PROVIDER_ID, name: 'Antigravity (ACP)' }
  }

  override async listModels(_provider: string): Promise<LlmModelInfo[]> {
    try {
      const models = await this.deps.pool.refreshModels()
      if (models.length > 0) {
        return models.map((m) => ({
          provider: PROVIDER_ID,
          id: m.value,
          name: m.name,
          inputModalities: ['text', 'image'] as const,
        }))
      }
    } catch (err) {
      this.deps.log?.(`listModels fallback: ${err instanceof Error ? err.message : String(err)}`)
    }
    return FALLBACK_MODELS
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

    const hasMirrorTool = Boolean(options.tools?.some((t) => t.name === MIRROR_TOOL_NAME))
    const isCodeMode = Boolean(options.tools?.some((t) => t.name === WRAPPER_TOOL_NAME)) && !hasMirrorTool
    const cutOnTool = hasMirrorTool || isCodeMode

    // 1. Continuation span: DSH just executed `agy_acp_tool` and is resuming the same ACP turn.
    const continuation = detectContinuation(options.messages)
    if (continuation) {
      const rec = this.deps.runs.get(continuation.runId)
      if (rec) {
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

    // 2. Fresh turn over persistent ACP session.
    const sessionKey = resolveSessionKey(options)
    const cwd = cfg.workspaceRoot || process.cwd()
    const { client, session, created } = await this.deps.pool.getOrCreateSession(sessionKey, cwd)

    const targetModel = options.model || cfg.defaultModel || session.currentModel
    const targetEffort =
      options.reasoningEffort !== undefined ? String(options.reasoningEffort) : cfg.defaultEffort || undefined
    const targetMode = cfg.permissionMode

    await this.deps.pool.syncSessionOptions(client, session, {
      model: targetModel,
      effort: targetEffort,
      mode: targetMode,
    })

    const promptBlocks = buildPromptBlocks(options.messages, created)
    const rec = this.deps.runs.create()
    rec.setCancelHandler(() => {
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
        this.deps.pool.recordTurnUsage(res.usage)
        rec.finish(res.stopReason, res.usage)
      })
      .catch((err: unknown) => {
        rec.fail(err instanceof Error ? err : new Error(String(err)))
      })
      .finally(() => {
        unsubscribe()
        rec.setCancelHandler(null)
        options.signal?.removeEventListener('abort', onAbort)
      })

    yield* this.driveRecording(rec, 0, cutOnTool, isCodeMode, options.signal)
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

function resolveSessionKey(options: GenerateOptions): string {
  const opt = options as unknown as { sessionId?: string; conversationId?: string; metadata?: { sessionId?: string } }
  return opt.sessionId ?? opt.conversationId ?? opt.metadata?.sessionId ?? 'default'
}
