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
import { AcpProcessExitError, AcpRpcError, AcpTimeoutError } from '../acp/client.ts'
import type { AcpToolCallUpdate } from '../acp/protocol.ts'
import { mapContextUsage } from '../acp/usage.ts'
import { defaultEffort, effortLabel } from '../common/effort.ts'
import { isGeoUnsupportedError } from '../common/geo.ts'
import {
  MIRROR_TOOL_NAME,
  PROVIDER_ID,
  WRAPPER_TOOL_NAME,
  type PluginConfig,
} from '../common/types.ts'
import { isQuotaOrRateLimitError } from '../runtime/account-pool.ts'
import { policyKey, SessionPolicyChangedError } from '../runtime/permission-manager.ts'
import { EgressBlockedError } from '../runtime/egress-guard.ts'
import type { AcpSessionPool, ManagedAcpSession } from '../runtime/session-pool.ts'
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
    let messages = options.messages as readonly PromptMessage[]
    let recoveryPolicy: string | undefined
    if (continuation) {
      const rec = this.deps.runs.get(continuation.runId)
      if (rec && rec.owner === sessionKey) {
        const callId = encodeMirrorCallId(rec.id, continuation.itemIndex)
        const callIndex = options.messages.findLastIndex(m => m.role === 'assistant' &&
          m.content.some(b => b.type === 'tool-call' && b.id === callId))
        if (callIndex >= 0 && !options.signal?.aborted && !cfg.mcpBridge && this.deps.runs.isLatestForOwner(rec)) {
          recoveryPolicy = rec.claimApprovalRecovery(continuation.itemIndex)
        }
        if (recoveryPolicy && policyKey(this.deps.pool.policy(sessionKey)) === recoveryPolicy) {
          // Keep the original user input (including images). The interrupted tool never produced a result.
          messages = messages.slice(0, callIndex)
          this.deps.log?.(`recreating ACP session "${sessionKey}" after interrupted approval (retry 1/1)`)
        } else {
          const onContAbort = () => rec.requestCancel()
          options.signal?.addEventListener('abort', onContAbort, { once: true })
          try {
            yield* this.driveRecording(rec, continuation.itemIndex + 1, cutOnTool, isCodeMode, options.signal)
          } finally {
            options.signal?.removeEventListener('abort', onContAbort)
          }
          return
        }
      }
    }

    // 2. Fresh turn over persistent ACP session (with automatic 429/geo failover + 1x pre-output crash recovery).
    const cwd = this.deps.pool.policy(sessionKey).workspaceRoot
    const requestedModel = options.model || cfg.defaultModel || ''
    const preparedSystem = prepareSystemPrompt(options.system)
    const triedAccounts = new Set<string>()
    let crashRetried = recoveryPolicy !== undefined
    let nextBlockIndex = 0
    let lastEgressBlockedError: EgressBlockedError | null = null
    const maxAccounts = Math.max(1, cfg.accounts.filter((a) => a.enabled !== false).length || 1)
    const maxIterations = maxAccounts + 2

    for (let iter = 0; iter < maxIterations; iter++) {
      options.signal?.throwIfAborted()
      let client: Awaited<ReturnType<AcpSessionPool['getOrCreateSession']>>['client']
      let session: ManagedAcpSession
      let created: boolean
      try {
        ;({ client, session, created } = await this.deps.pool.getOrCreateSession(
          sessionKey,
          cwd,
          requestedModel,
          triedAccounts.size > 0 ? triedAccounts : undefined,
          preparedSystem ?? undefined,
          recoveryPolicy ? { forceNew: true } : undefined,
        ))
      } catch (err) {
        if (err instanceof EgressBlockedError && !options.signal?.aborted) {
          lastEgressBlockedError = err
          triedAccounts.add(err.accountId)
          if (triedAccounts.size < maxAccounts) {
            this.deps.log?.(
              `account "${err.accountId}" blocked by local egress geo-fence, failing over (${triedAccounts.size}/${maxAccounts} tried)`,
            )
            continue
          }
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { code: 'ACP_ERROR', message: err.message },
            },
          }
          return
        }
        if (lastEgressBlockedError && err instanceof Error && /No healthy accounts available/i.test(err.message)) {
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { code: 'ACP_ERROR', message: lastEgressBlockedError.message },
            },
          }
          return
        }
        throw err
      }

      const targetModel = requestedModel || session.currentModel
      const policy = this.deps.pool.policy(sessionKey)
      if (recoveryPolicy && (!created || session.hasMcpServers || recoveryPolicy !== policyKey(policy))) {
        throw new Error('恢复时会话或权限已变更，请重新发起请求。')
      }
      const nativeAuto = session.configOptions.find(o => o.id === 'mode')?.options?.some(o => 'value' in o ? o.value === 'auto' : o.options.some(v => v.value === 'auto'))
      const targetMode = policy.preset === 'auto' && policy.mode === 'danger-full-access' && nativeAuto ? 'auto' : 'default'

      try {
        await this.deps.pool.syncSessionOptions(client, session, {
          model: targetModel,
          effort: options.reasoningEffort,
          configuredEffort: cfg.defaultEffort,
          mode: targetMode,
        })
      } catch (err) {
        if (err instanceof AcpProcessExitError) {
          if (this.deps.pool.owns(session)) this.deps.pool.invalidate(sessionKey)
          if (!crashRetried && !options.signal?.aborted) {
            crashRetried = true
            this.deps.log?.(`agy acp exited during option sync for "${sessionKey}", recreating session (retry 1/1)`)
            continue
          }
        }
        throw err
      }

      this.deps.pool.notifyStatusChange()
      const baseBlocks = buildPromptBlocks(messages, created)
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
      // agy emits usage_update at the end of a prompt, so seed with the last known occupancy for mirror boundaries.
      if (typeof session.contextUsed === 'number') rec.contextUsed = session.contextUsed
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

      let cleanedUp = false
      const cleanupTurn = (): void => {
        if (cleanedUp) return
        cleanedUp = true
        turn.finish()
        unsubscribe()
        rec.setCancelHandler(null)
        options.signal?.removeEventListener('abort', onAbort)
      }

      // Run `session/prompt` in background so the recording can span multiple DSH tool-mirror loops.
      void client
        .sessionPrompt({ sessionId: session.acpSessionId, prompt: promptBlocks }, cfg.requestTimeoutMs)
        .then((res) => {
          if (pendingSystemHash) this.deps.pool.recordAppliedSystemHash(session, pendingSystemHash)
          this.deps.pool.reportAccountSuccess(session.accountId, targetModel)
          this.deps.pool.recordTurnUsage(res.usage)
          // Release active turn slot synchronously BEFORE waking consumers to prevent next-turn race.
          cleanupTurn()
          rec.finish(res.stopReason, res.usage)
        })
        .catch((err: unknown) => {
          if (err instanceof SessionPolicyChangedError) {
            cleanupTurn()
            rec.fail(err)
            return
          }
          const isCleanRpcError = err instanceof AcpRpcError
          let error = err instanceof Error ? err : new Error(String(err))
          if (err instanceof AcpProcessExitError) {
            const { interruptedBeforeGrant, granted } = turn.permissions
            if (interruptedBeforeGrant) {
              if (cutOnTool && !crashRetried && !session.hasMcpServers && !cfg.mcpBridge && targetMode !== 'auto' && policy.approval === 'ask') {
                rec.allowApprovalRecovery(interruptedBeforeGrant, policyKey(policy))
              }
              error = new Error(`工具审批因 ACP 退出而中断，该请求尚未获准执行。 ${err.message}`, { cause: err })
            } else if ([...granted].some(id => !rec.getToolCall(id)?.settled)) {
              error = new Error(`工具已获准执行，但未收到执行结果。请先核对执行状态，再决定是否重试。 ${err.message}`, { cause: err })
            }
          }
          if (!(err instanceof AcpProcessExitError) && isGeoUnsupportedError(error)) {
            const snap = this.deps.pool.recordGeoRejection(session.accountId)
            this.deps.pool.reportAccountFailure(session.accountId, targetModel, error)
            const regionHint = snap.country ? `（当前检测地区：${snap.country}）` : ''
            error = new LlmError(
              `[地域限制熔断] 上游 Google API 拒绝了当前网络出口地域（400 FAILED_PRECONDITION）${regionHint}。已在本地立即熔断该账号出口 60 秒以防连续请求触发风控；请切换至 US / JP / SG / TW 等支持区域节点后，在控制台点击「检测出口」恢复。`,
              'ACP_GEO_UNSUPPORTED',
            )
          } else {
            this.deps.pool.reportAccountFailure(session.accountId, targetModel, error)
          }
          // Preserve healthy persistent processes on clean JSON-RPC application errors (`AcpRpcError`).
          // Invalidate on timeout, process crash, transport failure, or dead child.
          const shouldInvalidate =
            !client.isRunning || err instanceof AcpTimeoutError || !isCleanRpcError
          if (shouldInvalidate && this.deps.pool.owns(session)) {
            this.deps.pool.invalidate(sessionKey)
          }
          cleanupTurn()
          rec.fail(error)
        })
        .finally(() => {
          cleanupTurn()
        })

      // Peek first item before yielding so quota/429/geo failover and pre-output crash recovery stay seamless.
      const firstItem = await rec.waitFor(0, options.signal)
      if (firstItem?.kind === 'error' && !(firstItem.error instanceof AcpProcessExitError) && !turn.permissions.requests && !options.signal?.aborted) {
        const isGeoErr =
          isGeoUnsupportedError(firstItem.error) ||
          (firstItem.error instanceof LlmError && firstItem.error.code === 'ACP_GEO_UNSUPPORTED')
        if (isQuotaOrRateLimitError(firstItem.error) || isGeoErr) {
          triedAccounts.add(session.accountId)
          if (triedAccounts.size < maxAccounts) {
            this.deps.log?.(
              `account "${session.accountId}" hit ${isGeoErr ? 'geo-restriction' : 'quota/rate-limit'} on "${targetModel}", failing over (${triedAccounts.size}/${maxAccounts} tried)`,
            )
            await this.deps.pool.closeSession(sessionKey)
            continue
          }
        }
      }

      const resumeAt = yield* this.driveRecording(rec, 0, cutOnTool, isCodeMode, options.signal, nextBlockIndex, () =>
        !crashRetried && !options.signal?.aborted && !turn.permissions.requests &&
        !session.hasMcpServers && targetMode !== 'auto' && this.deps.runs.isLatestForOwner(rec) &&
        rec.items.every(item => item.kind === 'error' || (item.kind === 'update' &&
          ['agent_thought_chunk', 'usage_update', 'session_info_update', 'available_commands_update',
            'config_option_update'].includes(item.update.sessionUpdate))))
      if (resumeAt !== undefined && !options.signal?.aborted) {
        crashRetried = true
        recoveryPolicy = policyKey(policy)
        nextBlockIndex = resumeAt
        this.deps.log?.(`ACP exited before an answer or tool call for "${sessionKey}"; recreating session (retry 1/1)`)
        continue
      }
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
        let error = err instanceof Error ? err : new Error(String(err))
        if (isGeoUnsupportedError(error)) {
          error = new LlmError(
            '[地域限制熔断] 上游 Google API 拒绝了当前网络出口地域（400 FAILED_PRECONDITION）。已在本地熔断该账号出口 60 秒；请切换至支持区域节点后重试。',
            'ACP_GEO_UNSUPPORTED',
          )
        }
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
    blockStart = 0,
    canRetryExit?: () => boolean,
  ): AsyncGenerator<StreamChunk, number | void> {
    let idx = startIndex
    let blockIdx = blockStart
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
        if (item.error instanceof SessionPolicyChangedError) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: item.error.message } } }
          return
        }
        if (item.error instanceof AcpProcessExitError && canRetryExit?.()) return blockIdx
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
        const usage = mapContextUsage(item.usage, rec.contextUsed)
        if (usage) yield { type: 'usage', usage }
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

            // A mirror boundary has no ACP response usage; report live context occupancy so DSH can show it.
            const boundaryUsage = mapContextUsage(undefined, rec.contextUsed)
            if (boundaryUsage) yield { type: 'usage', usage: boundaryUsage }
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

    // DSH may append both snapshots while preparing the next step of this same turn.
    if (message.source?.kind === 'runtime-context' || message.source?.kind === 'time-context') {
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
