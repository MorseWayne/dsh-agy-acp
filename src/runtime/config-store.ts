import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sanitizePersistedConfigObject, validateConfigPatchInput } from '../common/config.ts'
import { sanitizeDiagnosticText } from '../common/sanitize.ts'
import type { PersistedConfigPatch } from '../common/types.ts'

const MAX_CONFIG_FILE_BYTES = 64 * 1024
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/

export interface ConfigStoreOptions {
  filePath?: string
  log?: (msg: string) => void
}

export function resolveConfigStorePath(explicitPath?: string): string {
  const candidate = explicitPath?.trim() || process.env.DSH_AGY_ACP_CONFIG_PATH?.trim() || ''
  if (candidate) {
    if (CONTROL_CHAR_RE.test(candidate)) {
      throw new Error('Invalid config store path')
    }
    return path.resolve(candidate)
  }
  return path.join(os.homedir(), '.dsh', 'agy-acp', 'config.json')
}

/**
 * Atomic, whitelist-enforced JSON persistence for user-editable runtime overrides.
 * Never persists sensitive host-only settings (`accounts`, `credentialSlotDir`, `permissionMode`).
 */
export class ConfigStore {
  readonly filePath: string
  private persisted: PersistedConfigPatch = {}
  private loaded = false
  private readonly log?: (msg: string) => void

  constructor(opts: ConfigStoreOptions = {}) {
    this.log = opts.log
    let resolved: string
    try {
      resolved = resolveConfigStorePath(opts.filePath)
    } catch {
      this.log?.('invalid DSH_AGY_ACP_CONFIG_PATH ignored; using default config path')
      resolved = path.join(os.homedir(), '.dsh', 'agy-acp', 'config.json')
    }
    this.filePath = resolved
  }

  get hasPersistedOverrides(): boolean {
    return Object.keys(this.persisted).length > 0
  }

  load(): { patch: PersistedConfigPatch; exists: boolean } {
    this.loaded = true
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(this.filePath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'ENOENT') {
        this.log?.(`config store stat warning: ${sanitizeDiagnosticText(String(err), 160)}`)
      }
      this.persisted = {}
      return { patch: {}, exists: false }
    }

    if (!stat.isFile()) {
      this.log?.('config store path is not a regular file; falling back to defaults')
      this.persisted = {}
      return { patch: {}, exists: false }
    }
    if (stat.size > MAX_CONFIG_FILE_BYTES) {
      this.log?.(`config store exceeds ${MAX_CONFIG_FILE_BYTES} bytes; falling back to defaults`)
      this.persisted = {}
      return { patch: {}, exists: false }
    }

    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.log?.('config store root is not a JSON object; falling back to defaults')
        this.persisted = {}
        return { patch: {}, exists: false }
      }
      const root = parsed as Record<string, unknown>
      const configNode =
        Object.hasOwn(root, 'config') && root.config && typeof root.config === 'object' && !Array.isArray(root.config)
          ? (root.config as Record<string, unknown>)
          : root
      const patch = sanitizePersistedConfigObject(configNode)
      this.persisted = patch
      return { patch: { ...patch }, exists: Object.keys(patch).length > 0 }
    } catch (err) {
      this.log?.(`config store parse warning: ${sanitizeDiagnosticText(String(err), 160)}`)
      this.persisted = {}
      return { patch: {}, exists: false }
    }
  }

  savePatch(patch: PersistedConfigPatch): PersistedConfigPatch {
    if (!this.loaded) {
      this.load()
    }
    const checked = validateConfigPatchInput(patch as Record<string, unknown>)
    if (!checked.ok) {
      throw new Error(checked.error)
    }

    const nextPersisted: PersistedConfigPatch = { ...this.persisted, ...checked.patch }
    const dir = path.dirname(this.filePath)
    mkdirSync(dir, { recursive: true, mode: 0o700 })

    const tmpPath = path.join(dir, `.config.${process.pid}.${randomUUID().slice(0, 8)}.tmp`)
    const payload = JSON.stringify({ version: 1, config: nextPersisted }, null, 2) + '\n'
    try {
      writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(tmpPath, this.filePath)
    } catch (err) {
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        // ignore cleanup failure
      }
      throw err
    }

    // Commit in-memory state ONLY after atomic rename succeeds.
    this.persisted = nextPersisted
    return { ...this.persisted }
  }

  reset(): void {
    rmSync(this.filePath, { force: true })
    this.persisted = {}
    this.loaded = true
  }
}
