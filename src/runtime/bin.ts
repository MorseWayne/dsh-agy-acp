import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveAgyBin(configured?: string): string | null {
  if (configured && configured.trim() !== '') {
    return isExecutable(configured.trim()) ? configured.trim() : null
  }

  const exeName = process.platform === 'win32' ? 'agy.exe' : 'agy'
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of pathEntries) {
    const candidate = join(dir, exeName)
    if (isExecutable(candidate)) return candidate
  }

  const home = homedir()
  const fallbacks =
    process.platform === 'win32'
      ? [join(home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe')]
      : [join(home, '.local', 'bin', 'agy'), '/usr/local/bin/agy', '/opt/homebrew/bin/agy']

  for (const candidate of fallbacks) {
    if (isExecutable(candidate)) return candidate
  }
  return null
}
