import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

function statIfPresent(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw error
  }
}

function relativeSegments(relative: string): string[] {
  const segments = relative.split('/')
  if (
    !relative ||
    path.isAbsolute(relative) ||
    /^[a-z]:/i.test(relative) ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(
      `Unsafe repository release path: ${relative}. No files were changed.`,
    )
  }
  return segments
}

export function validateMutablePaths(
  checkout: string,
  paths: readonly string[],
): void {
  const root = statIfPresent(checkout)
  if (!root?.isDirectory() || root.isSymbolicLink())
    throw new Error(
      'The module checkout must be a real directory. No files were changed.',
    )
  for (const relative of paths) {
    const segments = relativeSegments(relative)
    let current = checkout
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment)
      const status = statIfPresent(current)
      if (!status) continue
      if (status.isSymbolicLink())
        throw new Error(
          `Refusing to update repository symlink: ${relative}. No files were changed.`,
        )
      if (index < segments.length - 1 && !status.isDirectory())
        throw new Error(
          `Repository path ${relative} has a parent that is not a directory. No files were changed.`,
        )
      if (!status.isDirectory() && !status.isFile())
        throw new Error(
          `Repository path ${relative} is not a regular file or directory. No files were changed.`,
        )
    }
  }
}

export function assertNoCredentials(
  file: string,
  contents: string | Buffer,
): void {
  if (
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,})/.test(
      contents.toString(),
    )
  ) {
    throw new Error(
      `Possible credential in ${file}. Remove it before publishing. No files were published.`,
    )
  }
}

export function repositoryFingerprint(checkout: string, id: string): string {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(id))
    throw new Error('Invalid module ID for repository fingerprint.')
  const roots = [
    `src/modules/${id}`,
    'src/index.ts',
    'src/.npmignore',
    'package.json',
    'README.md',
    'LICENSE',
    'build.cjs',
    '.github/workflows/publish.yml',
    '.gitignore',
  ]
  validateMutablePaths(checkout, roots)
  const hash = createHash('sha256')
  function visit(relative: string): void {
    const file = path.join(checkout, ...relative.split('/'))
    const status = statIfPresent(file)
    hash.update(
      JSON.stringify([
        relative,
        status ? (status.isDirectory() ? 'directory' : 'file') : 'missing',
      ]),
    )
    hash.update('\0')
    if (!status) return
    const name = path.basename(relative)
    if (
      /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc.*|credentials(?:\.(?:json|ya?ml|txt))?|id_rsa|id_ed25519)$/.test(
        name,
      ) ||
      /\.(?:pem|key|p12|pfx)$/.test(name)
    )
      throw new Error(
        `Remove credential file from the module repository before publishing: ${relative}. No files were published.`,
      )
    if (status.isSymbolicLink())
      throw new Error(
        `Refusing to fingerprint repository symlink: ${relative}.`,
      )
    if (status.isDirectory()) {
      const entries = fs
        .readdirSync(file)
        .filter((name) => name !== '.git' && name !== 'node_modules')
        .sort()
      for (const name of entries) visit(`${relative}/${name}`)
    } else if (status.isFile()) {
      const contents = fs.readFileSync(file)
      assertNoCredentials(relative, contents)
      hash.update(String(contents.length))
      hash.update('\0')
      hash.update(contents)
      hash.update('\0')
    } else
      throw new Error(
        `Repository file ${relative} is not a regular file or directory.`,
      )
  }
  for (const relative of roots) visit(relative)
  return hash.digest('hex')
}
