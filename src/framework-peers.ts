import * as fs from 'node:fs'
import * as path from 'node:path'
import { packageDirectory } from './requirements.js'

type Version = { release: number[]; prerelease: string[] }

function parseVersion(value: string): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
  if (!match) return undefined
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

// Semver precedence.
function compare(a: Version, b: Version): number {
  for (let index = 0; index < 3; index += 1)
    if (a.release[index] !== b.release[index])
      return a.release[index] - b.release[index]
  if (!a.prerelease.length || !b.prerelease.length)
    return b.prerelease.length - a.prerelease.length
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const [left, right] = [a.prerelease[index], b.prerelease[index]]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const numeric = /^\d+$/
    if (numeric.test(left) && numeric.test(right)) return Number(left) - Number(right)
    if (numeric.test(left)) return -1
    if (numeric.test(right)) return 1
    return left < right ? -1 : 1
  }
  return 0
}

// Exact versions and caret ranges, the forms this tool and hand-edited module
// repositories use. Any other range is not judged (undefined).
export function satisfiesPeer(version: string, range: string): boolean | undefined {
  const installed = parseVersion(version)
  if (!installed) return undefined
  const exact = parseVersion(range)
  if (exact) return compare(installed, exact) === 0
  const lower = range.startsWith('^') ? parseVersion(range.slice(1)) : undefined
  if (!lower) return undefined
  const [major, minor, patch] = lower.release
  const upper: Version = {
    release: major > 0 ? [major + 1, 0, 0] : minor > 0 ? [0, minor + 1, 0] : [0, 0, patch + 1],
    prerelease: ['0'],
  }
  // A prerelease matches only prereleases of the same version as the range.
  if (
    installed.prerelease.length &&
    (!lower.prerelease.length || installed.release.join('.') !== lower.release.join('.'))
  )
    return false
  return compare(installed, lower) >= 0 && compare(installed, upper) < 0
}

function readManifest(directory: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// One readable warning instead of Yarn's YN0060 lines when an installed module
// was built for different @open-mercato/* versions than this app runs.
export function frameworkPeerWarning(appDirectory: string, packageName: string): string | undefined {
  const peers = readManifest(packageDirectory(appDirectory, packageName))?.peerDependencies
  if (!peers || typeof peers !== 'object') return undefined
  const mismatches: string[] = []
  for (const [name, range] of Object.entries(peers)) {
    if (!name.startsWith('@open-mercato/') || typeof range !== 'string') continue
    const version = readManifest(packageDirectory(appDirectory, name))?.version
    if (typeof version !== 'string') {
      mismatches.push(`${name}: module needs ${range}, app has it not installed`)
      continue
    }
    if (satisfiesPeer(version, range) === false)
      mismatches.push(`${name}: module needs ${range}, app has ${version}`)
  }
  if (!mismatches.length) return undefined
  return `⚠️ ${packageName} was built for other Open Mercato versions than this app uses:\n${mismatches.map((line) => `   ${line}`).join('\n')}\n   Yarn reports this as YN0060. The module may still work; check it in the app, or install a ${packageName} version released for this framework version.`
}
