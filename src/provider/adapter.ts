import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId, type ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { AcpToolCallUpdate } from '../acp/protocol.ts'
import { mapUsage } from '../acp/usage.ts'
import { defaultEffort, effortLabel } from '../common/effort.ts'
import {
  MIRROR_TOOL_NAME,
  PROVIDER_ID,
  WRAPPER_TOOL_NAME,
  type PluginConfig,
} from '../common/types.ts'
import { isQuotaOrRateLimitError } from '../runtime/account-pool.ts'
import type { AcpSessionPool } from '../runtime/session-pool.ts'
import { compactDisplayInput } from './mirror-tool.ts'
import {
  buildAuxiliaryPromptBlocks,
  buildPromptBlocks,
  buildSystemPromptBlock,
  prepareAuxiliarySystemPrompt,
  prepareSystemPrompt,
  type PromptMessage,
} from './prompt-builder.ts'
import {
  AcpRunRecording,
  decodeMirrorCallId,
  encodeMirrorCallId,
  normalizeLocations,
  type AcpRunStore,
  type MergedToolCall,
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
    return models.filter(m => !m.variantOf).map((m) => ({
      provider: PROVIDER_ID, id: m.value, name: m.name, inputModalities: ['text', 'image'],
    }))
  }

  override async resolveModel(_provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const models = await this.deps.pool.refreshModels().catch(() => [])
    const matched = models.find((m) => m.value === model)
    const contextWindow = this.deps.pool.contextWindowFor(model)
    const effort = defaultEffort(matched, this.deps.getConfig().defaultEffort)
    return {
      provider: PROVIDER_ID,
      id: model,
      name: matched?.name ?? model,
      inputModalities: ['text', 'image'],
      ...(contextWindow ? { context: { contextWindow } } : {}),
      ...(matched && effort
        ? {
            reasoning: {
              defaultEffort: ReasoningEffortId(effort),
              efforts: matched.efforts.map((e) => ({
                id: ReasoningEffortId(e),
                name: effortLabel(e),
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

    if (options.purpose) {
      yield* this.streamAuxiliary(options)
      return
    }

    const sessionKey = options.sessionId
    if (!sessionKey) {
      throw new Error('Antigravity requires an identified DSH conversation turn; auxiliary calls cannot execute native tools')
    }

    const hasMirrorTool = Boolean(options.tools?.some((t) => t.name === MIRROR_TOOL_NAME))
    const isCodeMode = Boolean(options.tools?.some((t) => t.name === WRAPPER_TOOL_NAME)) && !hasMirrorTool
    const cutOnTool = hasMirrorTool || isCodeMode

    // 1. Continuation span: DSH just executed `agy_acp_tool` and is resuming the same ACP turn.
    const continuation = detectContinuation(options.messages as readonly ContinuationMessage[])
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
    const preparedSystem = prepareSystemPrompt(options.system)
    const triedAccounts = new Set<string>()
    const maxAttempts = Math.max(1, cfg.accounts.filter((a) => a.enabled !== false).length || 1)

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { client, session, created } = await this.deps.pool.getOrCreateSession(
        sessionKey,
        cwd,
        requestedModel,
        triedAccounts.size > 0 ? triedAccounts : undefined,
        preparedSystem ?? undefined,
      )
      triedAccounts.add(session.accountId)

      const targetModel = requestedModel || session.currentModel
      const policy = this.deps.pool.policy(sessionKey)
      const nativeAuto = session.configOptions.find(o => o.id === 'mode')?.options?.some(o => 'value' in o ? o.value === 'auto' : o.options.some(v => v.value === 'auto'))
      const targetMode = policy.preset === 'auto' && policy.mode === 'danger-full-access' && nativeAuto ? 'auto' : 'default'

      await this.deps.pool.syncSessionOptions(client, session, {
        model: targetModel,
        effort: options.reasoningEffort,
        configuredEffort: cfg.defaultEffort,
        mode: targetMode,
      })

      this.deps.pool.notifyStatusChange()
      const baseBlocks = buildPromptBlocks(options.messages as readonly PromptMessage[], created)
      let pendingSystemHash: string | null = null
      let promptBlocks = baseBlocks
      if (preparedSystem) {
        if (created && !session.supportsSystemPromptAppend) {
          promptBlocks = [buildSystemPromptBlock(preparedSystem.append, false), ...baseBlocks]
          pendingSystemHash = preparedSystem.hash
        } else if (!created && session.appliedSystemHash !== preparedSystem.hash) {
          promptBlocks = [buildSystemPromptBlock(preparedSystem.append, true), ...baseBlocks]
          pendingSystemHash = preparedSystem.hash
        }
      }

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
          this.deps.pool.recordContextUsage(session, targetModel, update.used, typeof update.size === 'number' ? update.size : 0)
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
          if (pendingSystemHash) session.appliedSystemHash = pendingSystemHash
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

  private async *streamAuxiliary(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.signal?.aborted) {
      yield {
        type: 'finish',
        reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Request aborted by caller' } },
      }
      return
    }

    const cfg = this.deps.getConfig()
    const { append, fallbackBlock } = prepareAuxiliarySystemPrompt(options.purpose!, options.system)
    const prompt = buildAuxiliaryPromptBlocks(options.messages as readonly PromptMessage[])
    const rec = new AcpRunRecording(undefined, options.sessionId)
    const ac = new AbortController()
    const onAbort = (): void => ac.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    rec.setCancelHandler(() => ac.abort())
    const combinedSignal = options.signal ? AbortSignal.any([ac.signal, options.signal]) : ac.signal

    void this.deps.pool
      .runAuxiliaryPrompt({
        sessionKey: options.sessionId,
        model: options.model || cfg.defaultModel || undefined,
        effort: options.reasoningEffort,
        systemPromptAppend: append,
        systemFallbackBlock: fallbackBlock,
        prompt,
        signal: combinedSignal,
        onUpdate: (update) => rec.pushUpdate(update),
      })
      .then((res) => {
        rec.finish(res.stopReason, res.usage)
      })
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err))
        rec.fail(error)
      })
      .finally(() => {
        rec.setCancelHandler(null)
        options.signal?.removeEventListener('abort', onAbort)
      })

    yield* this.driveRecording(rec, 0, false, false, options.signal)
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

    const emitToolChunks = (tc: MergedToolCall, stepIdx: number): StreamChunk[] => {
      rec.markToolEmitted(tc.toolCallId)
      const toolName = isCodeMode ? WRAPPER_TOOL_NAME : MIRROR_TOOL_NAME
      const callId = encodeMirrorCallId(rec.id, stepIdx) as ToolCallId
      const locations = normalizeLocations(tc.locations)
      const rawInput = tc.rawInput ?? tc.args
      const mirrorPayload: Record<string, unknown> = {
        run: rec.id,
        step: stepIdx,
        toolCallId: tc.toolCallId,
        tool: tc.name ?? 'tool',
        ...(tc.title ? { title: tc.title } : {}),
        ...(tc.kind ? { kind: tc.kind } : {}),
        ...(locations ? { locations } : {}),
      }
      if (rawInput !== undefined) {
        const inputVal = isCodeMode ? compactDisplayInput(rawInput) : rawInput
        if (inputVal !== undefined) mirrorPayload.input = inputVal
      }

      const argsJson = isCodeMode
        ? JSON.stringify({
            code: `await tools[${JSON.stringify(MIRROR_TOOL_NAME)}](${JSON.stringify(mirrorPayload)})`,
          })
        : JSON.stringify(mirrorPayload)

      const startChunk: StreamChunk = { type: 'block-start', index: blockIdx, blockType: 'tool-call' }
      const endChunk: StreamChunk = {
        type: 'block-end',
        index: blockIdx,
        block: {
          type: 'tool-call',
          id: callId,
          name: toolName,
          arguments: argsJson,
        },
      }
      blockIdx++
      return [startChunk, endChunk]
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
      } else if (cutOnTool && (u.sessionUpdate === 'tool_call_update' || u.sessionUpdate === 'tool_call')) {
        const tcUpdate = u as AcpToolCallUpdate
        const toolCallId =
          typeof tcUpdate.toolCallId === 'string' && tcUpdate.toolCallId.trim() !== ''
            ? tcUpdate.toolCallId
            : `step:${idx}`
        if (!rec.isToolEmitted(toolCallId)) {
          const merged = rec.getToolCall(toolCallId)
          if (merged && isToolReadyToEmit(rec, idx, merged)) {
            const closed = closeOpenBlock()
            if (closed) yield closed

            for (const c of emitToolChunks(merged, idx)) yield c

            // Standard mode: batch immediately contiguous buffered ready tool calls without crossing text/thought/done/error.
            if (!isCodeMode) {
              while (idx + 1 < rec.items.length) {
                const nextItem = rec.items[idx + 1]!
                if (nextItem.kind !== 'update') break
                const nu = nextItem.update
                if (nu.sessionUpdate !== 'tool_call' && nu.sessionUpdate !== 'tool_call_update') break
                const nextTc = nu as AcpToolCallUpdate
                const nextId =
                  typeof nextTc.toolCallId === 'string' && nextTc.toolCallId.trim() !== ''
                    ? nextTc.toolCallId
                    : `step:${idx + 1}`
                if (rec.isToolEmitted(nextId)) {
                  idx++
                  continue
                }
                const nextMerged = rec.getToolCall(nextId)
                if (!nextMerged || !isToolReadyToEmit(rec, idx + 1, nextMerged)) break
                idx++
                for (const c of emitToolChunks(nextMerged, idx)) yield c
              }
            }

            // A mirror boundary is not another ACP request. Only the final response carries usage.
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
        }
      }

      idx++
    }
  }
}

function isToolReadyToEmit(rec: AcpRunRecording, idx: number, tc: MergedToolCall): boolean {
  if (tc.status === 'completed' || tc.status === 'failed' || tc.status === 'pending') return true
  const hasMetadata =
    Boolean(tc.name) ||
    Boolean(tc.title) ||
    tc.rawInput !== undefined ||
    tc.args !== undefined ||
    Boolean(tc.locations?.length)
  if (hasMetadata) return true
  // Pure placeholder `in_progress` frame: coalesce if next item is already buffered; otherwise emit immediately.
  return idx + 1 >= rec.items.length
}

// Read the shared fields structurally: older DSH puts results in user blocks,
// while newer DSH uses a separate tool message with a top-level call ID.
interface ContinuationMessage {
  readonly role: string
  readonly source?: { readonly kind?: string }
  readonly toolCallId?: unknown
  readonly content: readonly { readonly type: string; readonly toolCallId?: unknown; readonly text?: string }[]
}

export function detectContinuation(
  messages: readonly ContinuationMessage[],
): { runId: string; itemIndex: number } | null {
  let targetRunId: string | null = null
  let maxItemIndex = -1

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'tool') {
      const parsed = typeof message.toolCallId === 'string' ? decodeMirrorCallId(message.toolCallId) : null
      if (!parsed) break
      if (targetRunId === null) {
        targetRunId = parsed.runId
        maxItemIndex = parsed.itemIndex
      } else if (parsed.runId === targetRunId) {
        if (parsed.itemIndex > maxItemIndex) maxItemIndex = parsed.itemIndex
      } else {
        break
      }
      continue
    }

    if (message.role !== 'user') break

    // The host can append a runtime snapshot after tool results. Only skip trailing ones before results.
    if (message.source?.kind === 'runtime-context') {
      if (targetRunId === null) continue
      break
    }

    let matchedInUser = false
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j]
      if (block?.type === 'tool-result' && typeof block.toolCallId === 'string') {
        const parsed = decodeMirrorCallId(block.toolCallId)
        if (!parsed) continue
        if (targetRunId === null) {
          targetRunId = parsed.runId
          maxItemIndex = parsed.itemIndex
          matchedInUser = true
        } else if (parsed.runId === targetRunId) {
          if (parsed.itemIndex > maxItemIndex) maxItemIndex = parsed.itemIndex
          matchedInUser = true
        }
      }
    }
    if (!matchedInUser) break
  }

  return targetRunId !== null ? { runId: targetRunId, itemIndex: maxItemIndex } : null
}
