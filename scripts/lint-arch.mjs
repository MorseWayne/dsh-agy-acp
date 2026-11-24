#!/usr/bin/env node
/**
 * Enforces strict unidirectional layered architecture and acyclic imports across `src/`:
 *
 *   common -> (none)
 *   acp    -> common
 *   mcp    -> common, acp
 *   runtime -> common, acp
 *   provider -> common, acp, runtime
 *   transport -> common, runtime
 *   client -> common
 *   index  -> common, acp, mcp, runtime, provider, transport (never client)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC_DIR = path.join(ROOT, 'src')

const ALLOWED_LAYERS = {
  common: new Set(['common']),
  acp: new Set(['acp', 'common']),
  mcp: new Set(['mcp', 'common', 'acp']),
  runtime: new Set(['runtime', 'common', 'acp']),
  provider: new Set(['provider', 'common', 'acp', 'runtime']),
  transport: new Set(['transport', 'common', 'runtime']),
  client: new Set(['client', 'common']),
  index: new Set(['index', 'common', 'acp', 'mcp', 'runtime', 'provider', 'transport']),
}

function walkFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...walkFiles(full))
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

function getLayer(filePath) {
  const rel = path.relative(SRC_DIR, filePath).replaceAll('\\', '/')
  if (rel === 'index.ts') return 'index'
  const top = rel.split('/')[0]
  return top in ALLOWED_LAYERS ? top : 'unknown'
}

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g

function extractRelativeImports(filePath) {
  const src = readFileSync(filePath, 'utf8')
  const targets = []
  for (const match of src.matchAll(IMPORT_RE)) {
    const spec = match[1]
    if (!spec || !spec.startsWith('.')) continue
    const resolved = path.resolve(path.dirname(filePath), spec)
    targets.push({ spec, resolved })
  }
  return targets
}

const files = walkFiles(SRC_DIR)
const graph = new Map()
const violations = []

for (const file of files) {
  const fromLayer = getLayer(file)
  const fromRel = path.relative(ROOT, file).replaceAll('\\', '/')
  const deps = []

  for (const { spec, resolved } of extractRelativeImports(file)) {
    if (!resolved.startsWith(SRC_DIR)) continue
    const toLayer = getLayer(resolved)
    const toRel = path.relative(ROOT, resolved).replaceAll('\\', '/')
    deps.push(toRel)

    const allowed = ALLOWED_LAYERS[fromLayer]
    if (!allowed || !allowed.has(toLayer)) {
      violations.push(
        `[layer] ${fromRel} (${fromLayer}) -> ${toRel} (${toLayer}) via "${spec}" is forbidden`,
      )
    }
  }

  graph.set(fromRel, deps)
}

// Detect circular dependencies via DFS
const WHITE = 0
const GRAY = 1
const BLACK = 2
const color = new Map()
const stack = []

function dfs(node) {
  color.set(node, GRAY)
  stack.push(node)
  for (const next of graph.get(node) ?? []) {
    const c = color.get(next) ?? WHITE
    if (c === GRAY) {
      const cycleStart = stack.indexOf(next)
      const cycle = [...stack.slice(cycleStart), next].join(' -> ')
      violations.push(`[cycle] circular dependency detected: ${cycle}`)
    } else if (c === WHITE) {
      dfs(next)
    }
  }
  stack.pop()
  color.set(node, BLACK)
}

for (const node of graph.keys()) {
  if ((color.get(node) ?? WHITE) === WHITE) {
    dfs(node)
  }
}

if (violations.length > 0) {
  console.error(`Architecture lint failed (${violations.length} violation(s)):`)
  for (const v of violations) {
    console.error(`  - ${v}`)
  }
  process.exit(1)
}

console.log(`lint:arch passed (${files.length} source files checked, 0 violations)`)
