import * as fs from 'node:fs'
import * as path from 'node:path'
import * as ts from 'typescript'

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

function entryId(node: ts.Expression): string | undefined {
  const entry = unwrap(node)
  if (!ts.isObjectLiteralExpression(entry)) return undefined
  const id = property(entry, 'id')
  return id && ts.isStringLiteralLike(id) ? id.text : undefined
}

// Module ids registered in src/modules.ts: the enabledModules array plus
// entries pushed onto it conditionally. undefined means the app uses a
// configuration this reader does not understand, so nothing can be concluded.
function enabledModuleIds(appDirectory: string): Set<string> | undefined {
  const source = parse(path.join(appDirectory, 'src/modules.ts'))
  if (!source) return undefined
  let found = false
  const ids = new Set<string>()
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
          const id = entryId(element)
          if (id) ids.add(id)
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
        const id = entryId(argument)
        if (id) ids.add(id)
      }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found ? ids : undefined
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
          .filter((id) => moduleIdPattern.test(id))
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
    .filter((required) => required !== id && !enabled.has(required))
    .sort()
}

export function requirementsWarning(
  packageName: string,
  missing: string[],
): string {
  const many = missing.length > 1
  return `⚠️ ${packageName} requires ${many ? 'modules' : 'a module'} this app has not enabled: ${missing.join(', ')}.\n   Enable ${many ? 'them' : 'it'} in src/modules.ts first; Open Mercato's generators stop while a required module is missing.`
}
