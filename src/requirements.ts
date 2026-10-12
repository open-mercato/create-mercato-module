import * as fs from 'node:fs'
import * as path from 'node:path'
import * as ts from 'typescript'
import {
  normalizeModuleLocator,
  resolveModuleRequirement,
  type ModuleIdentity,
} from './module-locators.js'

const moduleIdPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

function parse(file: string): ts.SourceFile | undefined {
  try {
    return ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
  } catch {
    return undefined
  }
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  )
    current = current.expression
  return current
}

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const entry of object.properties)
    if (
      ts.isPropertyAssignment(entry) &&
      (ts.isIdentifier(entry.name) || ts.isStringLiteralLike(entry.name)) &&
      entry.name.text === name
    )
      return unwrap(entry.initializer)
  return undefined
}

interface EnabledModule {
  id: string
  from?: string
  locator?: string
  packageName?: string
}

const canonicalRequirement = normalizeModuleLocator

function installedRepository(
  appDirectory: string,
  packageName: string,
  moduleId: string,
  registeredLocator?: string,
): string | undefined {
  try {
    const packageDirectory = path.join(
      appDirectory,
      'node_modules',
      ...packageName.split('/'),
    )
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'),
    ) as {
      name?: string
      repository?: string | { url?: string; directory?: string }
    }
    if (manifest.name && manifest.name !== packageName) return undefined
    const repository =
      typeof manifest.repository === 'string'
        ? manifest.repository
        : !manifest.repository?.directory
          ? manifest.repository?.url
          : undefined
    if (repository && canonicalRequirement(repository)?.startsWith('github:'))
      return repository
    if (
      registeredLocator &&
      canonicalRequirement(registeredLocator)?.startsWith('github:')
    )
      return registeredLocator
    const directoryScoped =
      typeof manifest.repository === 'object' &&
      Boolean(manifest.repository?.directory)
    const metadataLocator = directoryScoped
      ? undefined
      : declaredLocator(
          path.join(packageDirectory, 'src/modules', moduleId, 'index.ts'),
        )
    if (
      metadataLocator &&
      canonicalRequirement(metadataLocator)?.startsWith('github:')
    )
      return metadataLocator
  } catch {}
  return undefined
}

function appDependencies(appDirectory: string): Record<string, unknown> {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(appDirectory, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
      optionalDependencies?: Record<string, unknown>
    }
    return {
      ...manifest.devDependencies,
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    }
  } catch {
    return {}
  }
}

function entryModule(node: ts.Expression): EnabledModule | undefined {
  const entry = unwrap(node)
  if (!ts.isObjectLiteralExpression(entry)) return undefined
  const id = property(entry, 'id')
  if (!id || !ts.isStringLiteralLike(id)) return undefined
  const from = property(entry, 'from')
  const locator = property(entry, 'locator')
  const packageName = property(entry, 'packageName')
  return {
    id: id.text,
    ...(packageName && ts.isStringLiteralLike(packageName)
      ? { packageName: packageName.text }
      : {}),
    ...(from && ts.isStringLiteralLike(from) ? { from: from.text } : {}),
    ...(locator && ts.isStringLiteralLike(locator)
      ? { locator: locator.text }
      : {}),
  }
}

// Module ids registered in src/modules.ts: the enabledModules array plus
// entries pushed onto it conditionally. undefined means the app uses a
// configuration this reader does not understand, so nothing can be concluded.
function enabledModuleIds(appDirectory: string): ModuleIdentity[] | undefined {
  const entries = enabledModuleEntries(appDirectory)
  if (!entries) return undefined
  const modules: ModuleIdentity[] = []
  const dependencies = appDependencies(appDirectory)
  function add(entry: EnabledModule | undefined): void {
    if (!entry) return
    const from = entry.from ?? '@open-mercato/core'
    const ids = new Set<string>()
    if (from === '@app') {
      if (entry.packageName) {
        const identity = canonicalRequirement(`npm:${entry.packageName}`)
        if (identity) ids.add(identity)
      }
      for (const locator of [
        entry.locator,
        declaredLocator(
          path.join(appDirectory, 'src/modules', entry.id, 'index.ts'),
        ),
      ]) {
        if (locator) {
          const identity = canonicalRequirement(locator)
          if (identity) ids.add(identity)
        }
      }
    }
    if (from && from !== '@app') {
      const identity = canonicalRequirement(`npm:${from}`)
      if (identity) ids.add(identity)
      const dependency = dependencies[from]
      const declaredOrigin =
        typeof dependency === 'string'
          ? dependency.replace(/^.*@(?=github:)/, '')
          : undefined
      const repository =
        declaredOrigin &&
        /^(?:github:|(?:git\+)?https?:|(?:git\+)?ssh:|git@|[^/@]+\/)/i.test(
          declaredOrigin,
        ) &&
        canonicalRequirement(declaredOrigin)?.startsWith('github:')
          ? declaredOrigin
          : installedRepository(appDirectory, from, entry.id, entry.locator)
      if (repository) {
        if (!repository.startsWith('npm:')) {
          const origin = canonicalRequirement(repository)
          if (origin?.startsWith('github:')) ids.add(origin)
        }
      }
    }
    modules.push({ id: entry.id, locators: [...ids] })
  }
  for (const entry of entries) add(entry)
  return modules
}

function enabledModuleEntries(
  appDirectory: string,
): EnabledModule[] | undefined {
  const source = parse(path.join(appDirectory, 'src/modules.ts'))
  if (!source) return undefined
  const entries: EnabledModule[] = []
  let found = false
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'enabledModules' &&
      node.initializer
    ) {
      const list = unwrap(node.initializer)
      if (ts.isArrayLiteralExpression(list)) {
        found = true
        for (const element of list.elements) {
          {
            const entry = entryModule(element)
            if (entry) entries.push(entry)
          }
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'push' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'enabledModules'
    )
      for (const argument of node.arguments) {
        {
          const entry = entryModule(argument)
          if (entry) entries.push(entry)
        }
      }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found ? entries : undefined
}

export function assertNoModuleCollision(
  appDirectory: string,
  id: string,
  packageName: string,
  repository: string,
): void {
  const local = path.join(appDirectory, 'src/modules', id)
  if (fs.existsSync(local))
    throw new Error(
      `Module ${id} already exists at ${local}; ${repository} would collide with this local module. Keep or explicitly remove it before installing another source. No files were changed.`,
    )
  const requested = canonicalRequirement(`github:${repository}`)
  const dependencies = appDependencies(appDirectory)
  for (const entry of enabledModuleEntries(appDirectory) ?? []) {
    if (entry.id !== id) continue
    const dependency = entry.from ? dependencies[entry.from] : undefined
    const origin =
      entry.locator ??
      (typeof dependency === 'string'
        ? dependency.replace(/^.*@(?=github:)/, '')
        : undefined)
    const identity = origin ? canonicalRequirement(origin) : undefined
    if (
      entry.from !== packageName ||
      (identity && identity !== requested && !moduleIdPattern.test(identity))
    )
      throw new Error(
        `Module ${id} is already registered from ${entry.locator ?? entry.from ?? 'an unknown source'}; ${repository} would register the same module ID from ${packageName}. Keep the existing module or explicitly remove it before installing another source. No files were changed.`,
      )
  }
}

function declaredLocator(indexFile: string): string | undefined {
  const source = parse(indexFile)
  if (!source) return undefined
  let locator: string | undefined
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'metadata' &&
      node.initializer
    ) {
      const metadata = unwrap(node.initializer)
      const value = ts.isObjectLiteralExpression(metadata)
        ? property(metadata, 'locator')
        : undefined
      if (value && ts.isStringLiteralLike(value)) locator = value.text
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return locator
}

// Open Mercato declares hard dependencies as `requires` in the `metadata`
// export of a module's index.ts (ModuleInfo.requires).
function declaredRequirements(indexFile: string): string[] {
  const source = parse(indexFile)
  if (!source) return []
  let requires: string[] = []
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'metadata' &&
      node.initializer
    ) {
      const metadata = unwrap(node.initializer)
      const list = ts.isObjectLiteralExpression(metadata)
        ? property(metadata, 'requires')
        : undefined
      if (list && ts.isArrayLiteralExpression(list))
        requires = list.elements
          .filter(ts.isStringLiteralLike)
          .map((element) => element.text)
          .filter((id) => canonicalRequirement(id) !== undefined)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return requires
}

/**
 * Modules an installed package requires that the app has not enabled.
 * Reads only; an unreadable package or app configuration yields no result.
 */
export function missingRequirements(
  appDirectory: string,
  packageName: string,
  moduleId?: string,
): string[] {
  const packageDirectory = path.join(
    appDirectory,
    'node_modules',
    ...packageName.split('/'),
  )
  let id = moduleId
  if (!id) {
    try {
      const manifest: unknown = JSON.parse(
        fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'),
      )
      const marker =
        manifest && typeof manifest === 'object' && 'mercatoModule' in manifest
          ? manifest.mercatoModule
          : undefined
      if (
        marker &&
        typeof marker === 'object' &&
        'id' in marker &&
        typeof marker.id === 'string'
      )
        id = marker.id
    } catch {}
  }
  if (!id || !moduleIdPattern.test(id)) return []
  const requires = declaredRequirements(
    path.join(packageDirectory, 'src/modules', id, 'index.ts'),
  )
  if (!requires.length) return []
  const enabled = enabledModuleIds(appDirectory)
  if (!enabled) return []
  return [...new Set(requires)]
    .filter(
      (required) =>
        required !== id && !resolveModuleRequirement(required, enabled),
    )
    .sort()
}

export function requirementsWarning(
  packageName: string,
  missing: string[],
): string {
  const many = missing.length > 1
  const commands = missing
    .filter((required) => !moduleIdPattern.test(required))
    .map(
      (required) =>
        `   npx create-mercato-module install '${required.replaceAll("'", "'\"'\"'")}'`,
    )
  return `⚠️ ${packageName} requires ${many ? 'modules' : 'a module'} this app has not enabled: ${missing.join(', ')}.\n   Enable ${many ? 'them' : 'it'} in src/modules.ts first; Open Mercato's generators stop while a required module is missing.${commands.length ? `\nInstall missing packages:\n${commands.join('\n')}` : ''}`
}
