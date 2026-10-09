import * as fs from 'node:fs'
import * as path from 'node:path'
import * as ts from 'typescript'
import { isBuiltin } from 'node:module'

const omitted = new Set([
  'node_modules',
  '.git',
  '__tests__',
  '__integration__',
  '__mocks__',
  '.DS_Store',
])
const codePattern = /\.(?:[cm]?js|jsx|tsx?)$/

function isCredentialFile(name: string): boolean {
  return (
    /^(?:\.env(?:\.(?!(?:example|sample|template)$).*)?|\.envrc|\.npmrc|\.yarnrc.*|\.netrc|\.git-credentials|\.pypirc|credentials(?:\.(?:json|ya?ml|txt))?|id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(
      name,
    ) || /\.(?:pem|key|p12|pfx|jks|keystore)$/.test(name)
  )
}

function inside(root: string, file: string) {
  const relative = path.relative(root, file)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

function filesIn(root: string): string[] {
  const files: string[] = []
  let total = 0
  function visit(directory: string) {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (
        omitted.has(entry.name) ||
        /\.(?:test|spec|typecheck)\.[^.]+$/.test(entry.name)
      )
        continue
      const file = path.join(directory, entry.name)
      if (entry.isSymbolicLink())
        throw new Error(`Cannot package symlink: ${path.relative(root, file)}`)
      if (isCredentialFile(entry.name)) {
        throw new Error(
          `Remove credential file from the module before publishing: ${path.relative(root, file)}`,
        )
      }
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) {
        total += fs.statSync(file).size
        if (total > 64 * 1024 * 1024 || files.length >= 10000)
          throw new Error('Module exceeds the 64 MB / 10,000 file limit.')
        files.push(file)
      } else throw new Error(`Cannot package special file: ${file}`)
    }
  }
  visit(root)
  return files
}

function localTarget(
  file: string,
  specifier: string,
  root: string,
  id: string,
): string | null {
  let candidate: string
  if (specifier.startsWith('@/')) {
    const prefix = `@/modules/${id}/`
    if (specifier !== `@/modules/${id}` && !specifier.startsWith(prefix)) {
      const generated = specifier.startsWith('@/.mercato/generated/')
      const sourceFile = `src/modules/${id}/${path.relative(root, file).split(path.sep).join('/')}`
      const explanation = generated
        ? 'This import points to files generated for this particular app. A published module cannot depend on another app having the same generated files.'
        : 'This import points to application code outside the selected module.'
      const suggestion = generated
        ? `Change the import in ${sourceFile}, not the generated file.\nFor generated entity field names, create module-owned constants such as export const id = 'id' as const in lib/entityFields.ts.\nFor generated entity IDs, use the stable 'module:entity' identifiers in module-owned code, or an exported API from the owning package.\nDo not move, edit, or publish the app's .mercato/generated directory.`
        : 'Move the shared source into this module, or import it from a separately published package.'
      throw new Error(
        `Cannot package an app-only import.\n\n📄 Source file: ${sourceFile}\n🔗 Import: ${specifier}\n\n${explanation}\n\n🛠️ Fix: ${suggestion}\n\nNo files were published.`,
      )
    }
    candidate =
      specifier === `@/modules/${id}`
        ? root
        : path.join(root, specifier.slice(prefix.length))
  } else if (specifier.startsWith('.'))
    candidate = path.resolve(path.dirname(file), specifier)
  else return null
  if (!inside(root, candidate))
    throw new Error(
      `${path.relative(root, file)} imports outside this module: ${specifier}`,
    )
  const base = candidate.replace(/\.(?:jsx?|tsx?)$/, '')
  const candidates = [
    candidate,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.js', '.json'].map(
      (extension) => `${base}${extension}`,
    ),
    ...['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.js'].map(
      (name) => path.join(candidate, name),
    ),
  ]
  const target = candidates.find(
    (entry) => fs.existsSync(entry) && fs.statSync(entry).isFile(),
  )
  if (!target)
    throw new Error(
      `${path.relative(root, file)} has an unresolved local import: ${specifier}`,
    )
  if (!inside(root, fs.realpathSync(target)))
    throw new Error(`Import escapes this module: ${specifier}`)
  return target
}

// A host's module list must be read at runtime, never copied from the publisher.
// Only the id-presence idiom has equivalent semantics in the runtime registry.
function rewriteHostModuleChecks(source: string, file: string): string {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const imports = parsed.statements.filter(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@/modules',
  )
  if (!imports.length) return source
  function fail(): never {
    throw new Error(
      `Cannot package this use of @/modules in ${file}. Only server-side enabledModules.some(module => module.id === 'module_id') checks can be translated to the consuming app's runtime registry. Other app configuration imports must use a portable API. No files were published.`,
    )
  }
  if (parsed.statements.some(node => ts.isExpressionStatement(node) &&
    ts.isStringLiteral(node.expression) && node.expression.text === 'use client')) fail()
  const host = ts.createCompilerHost({ noResolve: true, noLib: true })
  host.getSourceFile = name => name === file ? parsed : undefined
  const checker = ts.createProgram([file], { noResolve: true, noLib: true }, host).getTypeChecker()
  const bindings = new Set<ts.Symbol>()
  for (const declaration of imports) {
    const clause = declaration.importClause
    if (!clause || clause.isTypeOnly || clause.name || !clause.namedBindings ||
      !ts.isNamedImports(clause.namedBindings) || clause.namedBindings.elements.length !== 1) fail()
    const binding = clause.namedBindings.elements[0]
    if (binding.isTypeOnly || (binding.propertyName ?? binding.name).text !== 'enabledModules') fail()
    const symbol = checker.getSymbolAtLocation(binding.name)
    if (!symbol) fail()
    bindings.add(symbol)
  }
  const references = new Set<ts.Identifier>()
  const identifiers = new Set<string>()
  function inspect(node: ts.Node): void {
    if (ts.isIdentifier(node)) identifiers.add(node.text)
    if (ts.isImportDeclaration(node)) return
    if (ts.isIdentifier(node) && bindings.has(checker.getSymbolAtLocation(node)!)) {
      const access = node.parent
      const call = access.parent
      if (!ts.isPropertyAccessExpression(access) || access.expression !== node || access.name.text !== 'some' ||
        !ts.isCallExpression(call) || call.expression !== access || call.arguments.length !== 1 ||
        access.questionDotToken || call.questionDotToken) fail()
      const callback = call.arguments[0]
      if (!ts.isArrowFunction(callback) || callback.modifiers?.length || callback.parameters.length !== 1) fail()
      const parameter = callback.parameters[0]
      if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken) fail()
      let body = callback.body
      while (ts.isParenthesizedExpression(body)) body = body.expression
      if (!ts.isBinaryExpression(body) || body.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) fail()
      const isId = (value: ts.Node) => ts.isPropertyAccessExpression(value) && !value.questionDotToken &&
        ts.isIdentifier(value.expression) && value.expression.text === parameter.name.getText(parsed) && value.name.text === 'id'
      if (!((isId(body.left) && ts.isStringLiteral(body.right)) ||
        (ts.isStringLiteral(body.left) && isId(body.right)))) fail()
      references.add(node)
    }
    ts.forEachChild(node, inspect)
  }
  inspect(parsed)
  // Include import bindings too so the generated name cannot shadow an import.
  for (const declaration of parsed.statements) {
    if (ts.isImportDeclaration(declaration)) {
      const collect = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) identifiers.add(node.text)
        ts.forEachChild(node, collect)
      }
      collect(declaration)
    }
  }
  let helper = '__mercatoGetModules'
  while (identifiers.has(helper)) helper += '_'
  const result = ts.transform(parsed, [context => {
    const visitor: ts.Visitor = node => {
      if (ts.isImportDeclaration(node) && imports.includes(node)) return undefined
      if (ts.isIdentifier(node) && references.has(node)) {
        return ts.factory.createCallExpression(ts.factory.createIdentifier(helper), undefined, [])
      }
      return ts.visitEachChild(node, visitor, context)
    }
    return node => {
      const updated = ts.visitNode(node, visitor) as ts.SourceFile
      if (!references.size) return updated
      const declaration = ts.factory.createImportDeclaration(undefined,
        ts.factory.createImportClause(false, undefined, ts.factory.createNamedImports([
          ts.factory.createImportSpecifier(false, ts.factory.createIdentifier('getModules'), ts.factory.createIdentifier(helper)),
        ])), ts.factory.createStringLiteral('@open-mercato/shared/lib/modules/registry'))
      // Append the import so leading directives retain their position.
      return ts.factory.updateSourceFile(updated, [...updated.statements, declaration])
    }
  }])
  try {
    return ts.createPrinter().printFile(result.transformed[0])
  } finally {
    result.dispose()
  }
}

function rewriteSource(
  source: string,
  file: string,
  root: string,
  id: string,
  onDependency: (name: string) => void = () => {},
): string {
  const parsed = ts.createSourceFile(file, rewriteHostModuleChecks(source, file), ts.ScriptTarget.Latest, true)
  function specifier(value: string) {
    const target = localTarget(file, value, root, id)
    if (target) {
      const relative = path
        .relative(path.dirname(file), target)
        .split(path.sep)
        .join('/')
        .replace(/\.(?:tsx?|jsx)$/, '.js')
      return relative.startsWith('.') ? relative : `./${relative}`
    }
    if (isBuiltin(value)) return value
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:\/.*)?$/i.test(value))
      throw new Error(
        `Unsupported import ${value} in ${path.relative(root, file)}.`,
      )
    onDependency(
      value.startsWith('@')
        ? value.split('/').slice(0, 2).join('/')
        : value.split('/')[0],
    )
    return value
  }
  const result = ts.transform(parsed, [
    (context) => {
      function visitor(node: ts.Node): ts.VisitResult<ts.Node> {
        if (ts.isImportEqualsDeclaration(node))
          throw new Error(
            `Replace import = require with an ES import in ${path.relative(root, file)} before publishing.`,
          )
        if (
          ts.isImportTypeNode(node) &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal)
        ) {
          const argument = ts.factory.createLiteralTypeNode(
            ts.factory.createStringLiteral(
              specifier(node.argument.literal.text),
            ),
          )
          return ts.factory.updateImportTypeNode(
            node,
            argument,
            node.attributes,
            node.qualifier,
            node.typeArguments,
            node.isTypeOf,
          )
        }
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier
        ) {
          const replacement = ts.factory.createStringLiteral(
            specifier((node.moduleSpecifier as ts.StringLiteral).text),
          )
          return ts.isImportDeclaration(node)
            ? ts.factory.updateImportDeclaration(
                node,
                node.modifiers,
                node.importClause,
                replacement,
                node.attributes,
              )
            : ts.factory.updateExportDeclaration(
                node,
                node.modifiers,
                node.isTypeOnly,
                node.exportClause,
                replacement,
                node.attributes,
              )
        }
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) &&
              node.expression.text === 'require'))
        ) {
          if (ts.isIdentifier(node.expression))
            throw new Error(
              `Replace require() with an ES import or import() in ${path.relative(root, file)} before publishing.`,
            )
          const argument = node.arguments[0]
          if (
            !argument ||
            (!ts.isStringLiteral(argument) &&
              !ts.isNoSubstitutionTemplateLiteral(argument))
          )
            throw new Error(
              `Use a literal import/require path in ${path.relative(root, file)} before publishing.`,
            )
          return ts.factory.updateCallExpression(
            node,
            node.expression,
            node.typeArguments,
            [
              ts.factory.createStringLiteral(specifier(argument.text)),
              ...node.arguments.slice(1),
            ],
          )
        }
        return ts.visitEachChild(node, visitor, context)
      }
      return (node) => ts.visitNode(node, visitor) as ts.SourceFile
    },
  ])
  try {
    return ts.createPrinter().printFile(result.transformed[0])
  } finally {
    result.dispose()
  }
}

function compile(source: string, file: string): string {
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      useDefineForClassFields: false,
      isolatedModules: true,
      esModuleInterop: true,
    },
  })
  const errors = (result.diagnostics || []).filter(
    (entry) => entry.category === ts.DiagnosticCategory.Error,
  )
  if (errors.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(errors, {
        getCanonicalFileName: (name) => name,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
      }),
    )
  return result.outputText
}

function build(packageDirectory: string): void {
  const manifest: { mercatoModule?: { id?: string } } = JSON.parse(
    fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'),
  )
  const id = manifest.mercatoModule?.id
  if (!id || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(id))
    throw new Error('Missing mercatoModule.id in package.json.')
  const sourceRoot = path.join(packageDirectory, 'src/modules', id)
  const outputRoot = path.join(packageDirectory, 'dist/modules', id)
  const typesRoot = path.join(packageDirectory, 'types/modules', id)
  fs.rmSync(path.join(packageDirectory, 'dist'), {
    recursive: true,
    force: true,
  })
  fs.rmSync(path.join(packageDirectory, 'types'), {
    recursive: true,
    force: true,
  })
  for (const file of filesIn(sourceRoot)) {
    const relative = path.relative(sourceRoot, file)
    const output = path.join(
      outputRoot,
      relative.replace(/\.(?:tsx?|jsx)$/, '.js'),
    )
    fs.mkdirSync(path.dirname(output), { recursive: true })
    const typeOutput = path.join(typesRoot, relative)
    fs.mkdirSync(path.dirname(typeOutput), { recursive: true })
    if (codePattern.test(file) && !file.endsWith('.d.ts')) {
      const source = rewriteSource(
        fs.readFileSync(file, 'utf8'),
        file,
        sourceRoot,
        id,
      )
      fs.writeFileSync(output, compile(source, file))
      fs.writeFileSync(typeOutput, source)
    } else {
      fs.copyFileSync(
        file,
        path.join(path.dirname(output), path.basename(file)),
      )
      fs.copyFileSync(file, typeOutput)
    }
  }
  fs.writeFileSync(
    path.join(packageDirectory, 'dist/index.js'),
    `export { metadata } from './modules/${id}/index.js'\n`,
  )
  fs.writeFileSync(
    path.join(packageDirectory, 'types/index.ts'),
    `export { metadata } from './modules/${id}/index.js'\n`,
  )
}

if (require.main === module) build(process.cwd())
export {
  filesIn,
  localTarget,
  rewriteSource,
  compile,
  build,
  codePattern,
  isCredentialFile,
}
