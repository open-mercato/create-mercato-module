import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'

export interface DevelopmentApp {
  directory: string
}

export interface DevelopmentLink {
  formatVersion: 1
  repository: string
  packageName: string
  checkoutPath: string
  sourcePath: string
  backupPath: string
}

export interface DevelopmentOptions {
  repository: string
  packageName: string
  linkedDevelopment?: DevelopmentLink
  checkoutName?: string
  registerMissing?: boolean
}

export interface DevelopmentRunOptions {
  capture?: boolean
  allowFailure?: boolean
}
export interface DevelopmentRunResult {
  status: number | null
  stdout: string
  stderr: string
}
export type DevelopmentRunner = (
  command: string,
  args: string[],
  cwd: string,
  options?: DevelopmentRunOptions,
) => DevelopmentRunResult

const executeCommand: DevelopmentRunner = (
  command,
  args,
  cwd,
  options = {},
) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...(options.capture
      ? { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }
      : {}),
  })
  if (result.error)
    throw new Error(`Cannot run ${command}: ${result.error.message}`)
  if (result.status !== 0 && !options.allowFailure) {
    const details = options.capture ? (result.stderr ?? '').trim() : ''
    throw new Error(
      `${command} failed.${details ? `\n\n${details.slice(-3000)}\n\nFix this error and retry.` : ' Fix the reported error and retry.'}`,
    )
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function exists(file: string): boolean {
  try {
    fs.lstatSync(file)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false
    throw error
  }
}

function validateIdentity(id: string, options: DevelopmentOptions): void {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(id))
    throw new Error(
      'Use a module name in snake_case, for example customer_visits.',
    )
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(
      options.repository,
    ) ||
    options.repository.endsWith('.git')
  )
    throw new Error(
      'Use a GitHub repository as owner/name, without a URL or .git suffix.',
    )
  if (
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(
      options.packageName,
    )
  )
    throw new Error('Use a valid npm package name for the module repository.')
}

function realDirectories(
  root: string,
  relative: string,
  create = false,
): string {
  let directory = root
  for (const segment of relative.split('/')) {
    if (!segment || segment === '.' || segment === '..')
      throw new Error(
        'The development metadata contains an unsafe path. No files were changed.',
      )
    directory = path.join(directory, segment)
    if (!exists(directory) && create) fs.mkdirSync(directory)
    if (
      !exists(directory) ||
      !fs.lstatSync(directory).isDirectory() ||
      fs.lstatSync(directory).isSymbolicLink()
    )
      throw new Error(
        `Expected a real directory at ${path.relative(root, directory)}. Development paths must not pass through symlinks.`,
      )
  }
  return directory
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  )
    return unwrapExpression(expression.expression)
  return expression
}

function assertAppRegistration(
  root: string,
  id: string,
  options: DevelopmentOptions,
): string | undefined {
  const source = realDirectories(root, 'src')
  const modulesFile = path.join(source, 'modules.ts')
  if (
    !exists(modulesFile) ||
    !fs.lstatSync(modulesFile).isFile() ||
    fs.lstatSync(modulesFile).isSymbolicLink()
  )
    throw new Error(
      'src/modules.ts must be a regular file before linking module development. No files were changed.',
    )
  const parsed = ts.createSourceFile(
    'modules.ts',
    fs.readFileSync(modulesFile, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
  const declarations = parsed.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === 'enabledModules',
    )
  const initializer =
    declarations.length === 1 && declarations[0].initializer
      ? unwrapExpression(declarations[0].initializer)
      : undefined
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
    throw new Error(
      `Cannot verify ${id} in src/modules.ts. Use a literal enabledModules array with { id: '${id}', from: '@app' } before linking development. No files were changed.`,
    )
  }
  const matching: (string | undefined)[] = []
  let packageRegistration: ts.ObjectLiteralExpression | undefined
  for (const element of initializer.elements) {
    const candidate = unwrapExpression(element)
    if (
      !ts.isObjectLiteralExpression(candidate) ||
      candidate.properties.some(
        (property) =>
          !ts.isPropertyAssignment(property) ||
          (ts.isComputedPropertyName(property.name) &&
            !ts.isStringLiteralLike(
              unwrapExpression(property.name.expression),
            )),
      )
    ) {
      if (options.registerMissing)
        throw new Error(
          'Cannot safely update dynamic module registration in src/modules.ts. Register the module as @app manually, then retry. No files were changed.',
        )
      continue
    }
    let moduleId: string | undefined
    let from: string | undefined
    const seen = new Set<string>()
    for (const property of candidate.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      const name = ts.isComputedPropertyName(property.name)
        ? unwrapExpression(property.name.expression)
        : property.name
      const key =
        ts.isIdentifier(name) || ts.isStringLiteralLike(name)
          ? name.text
          : undefined
      const value = unwrapExpression(property.initializer)
      if (options.registerMissing && key && ['id', 'from'].includes(key)) {
        if (seen.has(key) || !ts.isStringLiteralLike(value))
          throw new Error(
            'Cannot safely update ambiguous module registration in src/modules.ts. Use one literal id and from per module. No files were changed.',
          )
        seen.add(key)
      }
      if (key === 'id')
        moduleId = ts.isStringLiteralLike(value) ? value.text : undefined
      if (key === 'from')
        from = ts.isStringLiteralLike(value) ? value.text : undefined
    }
    if (options.registerMissing && !moduleId)
      throw new Error(
        'Cannot safely update a module registration without a literal id in src/modules.ts. No files were changed.',
      )
    if (moduleId === id) {
      matching.push(from)
      if (from === options.packageName) packageRegistration = candidate
    }
  }
  if (
    options.registerMissing &&
    (matching.length === 0 || (matching.length === 1 && packageRegistration))
  ) {
    const text = parsed.text
    if (packageRegistration) {
      const from = packageRegistration.properties.find((property) => {
        if (!ts.isPropertyAssignment(property)) return false
        const name = ts.isComputedPropertyName(property.name)
          ? unwrapExpression(property.name.expression)
          : property.name
        return (
          (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
          name.text === 'from'
        )
      }) as ts.PropertyAssignment
      return `${text.slice(0, from.initializer.getStart(parsed))}'@app'${text.slice(from.initializer.end)}`
    }
    const offset = initializer.end - 1
    const comma =
      initializer.elements.length && !initializer.elements.hasTrailingComma
        ? ','
        : ''
    return `${text.slice(0, offset)}${comma}\n  { id: '${id}', from: '@app' },\n${text.slice(offset)}`
  }
  if (matching.length !== 1 || matching[0] !== '@app') {
    throw new Error(
      `Module ${id} must be enabled once as a local @app module in src/modules.ts before linking development. Add or change its entry to { id: '${id}', from: '@app' }, then run yarn generate and retry. Linking keeps this registration and does not switch package registrations automatically. No files were changed.`,
    )
  }
}

function validateCheckout(
  root: string,
  checkoutPath: string,
  id: string,
  packageName: string,
): string {
  const checkout = realDirectories(root, checkoutPath)
  const manifestFile = path.join(checkout, 'package.json')
  if (
    !exists(manifestFile) ||
    !fs.lstatSync(manifestFile).isFile() ||
    fs.lstatSync(manifestFile).isSymbolicLink()
  )
    throw new Error(
      'The module repository must contain a regular package.json created by this tool.',
    )
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('name' in manifest) ||
    manifest.name !== packageName ||
    !('mercatoModule' in manifest) ||
    typeof manifest.mercatoModule !== 'object' ||
    manifest.mercatoModule === null ||
    !('id' in manifest.mercatoModule) ||
    manifest.mercatoModule.id !== id ||
    !('formatVersion' in manifest.mercatoModule) ||
    manifest.mercatoModule.formatVersion !== 1
  )
    throw new Error(
      `The repository does not belong to ${packageName} / ${id}. Choose the dedicated module repository created by publish.`,
    )
  const source = realDirectories(checkout, `src/modules/${id}`)
  const index = path.join(source, 'index.ts')
  if (
    !exists(index) ||
    !fs.lstatSync(index).isFile() ||
    fs.lstatSync(index).isSymbolicLink()
  )
    throw new Error(
      `The repository is missing its module source: src/modules/${id}/index.ts.`,
    )
  rejectSourceSymlinks(source, source)
  return source
}

function rejectSourceSymlinks(directory: string, sourceRoot: string): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isSymbolicLink())
      throw new Error(
        `The repository module contains a symlink at ${path.relative(sourceRoot, file)}. Keep its source files inside the module before linking development.`,
      )
    if (entry.isDirectory()) rejectSourceSymlinks(file, sourceRoot)
    else if (!entry.isFile())
      throw new Error(
        `The repository module contains an unsupported file at ${path.relative(sourceRoot, file)}.`,
      )
  }
}

function shareDependencies(appRoot: string, checkout: string): void {
  const dependencies = path.join(appRoot, 'node_modules')
  if (!exists(dependencies) || !fs.statSync(dependencies).isDirectory())
    throw new Error(
      'Install the app dependencies with yarn install before linking module development.',
    )
  const link = path.join(checkout, 'node_modules')
  if (exists(link)) {
    if (
      !fs.lstatSync(link).isSymbolicLink() ||
      fs.realpathSync(link) !== fs.realpathSync(dependencies)
    )
      throw new Error(
        'The module checkout has its own node_modules. Remove it before linking so the module shares the app React and framework packages.',
      )
  } else fs.symlinkSync(path.relative(checkout, dependencies), link, 'dir')
  excludeDependencies(checkout)
}

// A `node_modules/` ignore rule does not match the symlink created above.
function excludeDependencies(checkout: string): void {
  const git = path.join(checkout, '.git')
  if (
    !exists(git) ||
    !fs.lstatSync(git).isDirectory() ||
    fs.lstatSync(git).isSymbolicLink()
  )
    return
  const info = path.join(git, 'info')
  if (!exists(info)) fs.mkdirSync(info)
  const file = path.join(info, 'exclude')
  if (
    fs.lstatSync(info).isSymbolicLink() ||
    (exists(file) && !fs.lstatSync(file).isFile())
  )
    return
  const current = exists(file) ? fs.readFileSync(file, 'utf8') : ''
  if (current.split(/\r?\n/).includes('/node_modules')) return
  fs.writeFileSync(
    file,
    `${current}${current && !current.endsWith('\n') ? '\n' : ''}/node_modules\n`,
  )
}

// Linking needs the module to be released to its GitHub repository already.
// Checked before anything is cloned or moved, with the command that fixes it.
export function inspectDevelopmentRepository(
  root: string,
  repository: string,
  execute: DevelopmentRunner,
  expected?: { id: string; packageName: string },
): {
  name: string
  version?: string
  publishConfig?: { access?: string }
  mercatoModule: { id: string; formatVersion: 1 }
} {
  const publish = expected
    ? `  npx create-mercato-module publish ${expected.id} --package ${expected.packageName} --repo ${repository}`
    : `  npx create-mercato-module publish <module_id> --package <package-name> --repo ${repository}`
  const details = execute('gh', ['api', `repos/${repository}`], root, {
    capture: true,
    allowFailure: true,
  })
  if (details.status !== 0) {
    if (/HTTP 404/.test(details.stderr))
      throw new Error(
        `🐙 ${repository} does not exist on GitHub yet, or your account cannot see it. Linking needs the module in its dedicated repository first. Publish it there:\n\n${publish}\n\nThen run link again. If the repository exists, check the owner/name and gh auth status. No files were changed.`,
      )
    throw new Error(
      '🐙 Cannot inspect the GitHub repository. Check gh auth login and network access, then retry. No files were changed.',
    )
  }
  const file = execute(
    'gh',
    [
      'api',
      `repos/${repository}/contents/package.json`,
      '-H',
      'Accept: application/vnd.github.raw',
    ],
    root,
    { capture: true, allowFailure: true },
  )
  if (file.status !== 0) {
    if (/HTTP 404/.test(file.stderr))
      throw new Error(
        `🐙 ${repository} exists, but this module has not been published to it yet. Publish it first:\n\n${publish}\n\nThen run link again. No files were changed.`,
      )
    throw new Error(
      '🐙 Cannot read the GitHub repository. Check gh auth login and network access, then retry. No files were changed.',
    )
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(file.stdout)
  } catch {}
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !('name' in manifest) ||
    typeof manifest.name !== 'string' ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.name) ||
    manifest.name.length > 214 ||
    !('mercatoModule' in manifest) ||
    !manifest.mercatoModule ||
    typeof manifest.mercatoModule !== 'object' ||
    !('id' in manifest.mercatoModule) ||
    typeof manifest.mercatoModule.id !== 'string' ||
    !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(manifest.mercatoModule.id) ||
    !('formatVersion' in manifest.mercatoModule) ||
    manifest.mercatoModule.formatVersion !== 1
  )
    throw new Error(
      `🐙 ${repository} is not a dedicated Open Mercato module repository. Its package.json must declare a package name and mercatoModule with id and formatVersion: 1. Publish your module to its own repository first:\n\n${publish}\n\nNo files were changed.`,
    )
  if (
    expected &&
    (manifest.name !== expected.packageName ||
      manifest.mercatoModule.id !== expected.id)
  )
    throw new Error(
      `🐙 ${repository} holds ${manifest.name}, not ${expected.packageName} / ${expected.id}. Pass the repository this module was published to with --repo, or publish the module to a new dedicated repository:\n\n  npx create-mercato-module publish ${expected.id} --package ${expected.packageName} --repo <owner>/<new-repository>\n\nNo files were changed.`,
    )
  return manifest as ReturnType<typeof inspectDevelopmentRepository>
}

export function linkedModuleDirectory(
  app: DevelopmentApp,
  id: string,
  metadata: DevelopmentLink,
): string {
  validateIdentity(id, metadata)
  const checkoutPath = metadata.checkoutPath
  const sourcePath = `${checkoutPath}/src/modules/${id}`
  if (
    metadata.formatVersion !== 1 ||
    !/^\.mercato\/module-repos\/[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(
      checkoutPath,
    ) ||
    metadata.sourcePath !== sourcePath ||
    (metadata.backupPath !== '' &&
      !new RegExp(`^\\.mercato/module-backups/${id}-[a-zA-Z0-9-]+$`).test(
        metadata.backupPath,
      ))
  )
    throw new Error(
      'The saved development link is invalid. Refusing to follow an unowned module symlink.',
    )
  const root = fs.realpathSync(app.directory)
  const source = validateCheckout(root, checkoutPath, id, metadata.packageName)
  const modules = realDirectories(root, 'src/modules')
  const moduleLink = path.join(modules, id)
  if (
    !exists(moduleLink) ||
    !fs.lstatSync(moduleLink).isSymbolicLink() ||
    path.isAbsolute(fs.readlinkSync(moduleLink)) ||
    fs.realpathSync(moduleLink) !== source
  )
    throw new Error(
      `src/modules/${id} does not match the saved development checkout. No files were changed.`,
    )
  return source
}

export function linkDevelopment(
  app: DevelopmentApp,
  id: string,
  options: DevelopmentOptions,
  execute: DevelopmentRunner = executeCommand,
  commit: (link: DevelopmentLink) => void = () => {},
): DevelopmentLink {
  validateIdentity(id, options)
  const checkoutName =
    options.checkoutName ||
    options.linkedDevelopment?.checkoutPath.split('/').at(-1) ||
    id
  validateCheckoutName(checkoutName)
  const root = fs.realpathSync(app.directory)
  if (
    execute('gh', ['auth', 'status'], root, {
      capture: true,
      allowFailure: true,
    }).status !== 0
  )
    throw new Error(
      '🔐 Sign in to GitHub with gh auth login, then retry. No files were changed.',
    )
  const updatedRegistration = assertAppRegistration(root, id, options)
  const modules = path.join(root, 'src/modules')
  if (exists(modules) || !options.registerMissing)
    realDirectories(root, 'src/modules')
  const moduleDirectory = path.join(modules, id)
  if (
    exists(moduleDirectory) &&
    fs.lstatSync(moduleDirectory).isSymbolicLink()
  ) {
    if (
      !options.linkedDevelopment ||
      options.linkedDevelopment.repository !== options.repository ||
      options.linkedDevelopment.packageName !== options.packageName ||
      options.linkedDevelopment.checkoutPath !==
        `.mercato/module-repos/${checkoutName}`
    )
      throw new Error(
        `src/modules/${id} is already a symlink without matching saved development settings. Refusing to replace it.`,
      )
    linkedModuleDirectory(app, id, options.linkedDevelopment)
    shareDependencies(
      root,
      path.join(root, options.linkedDevelopment.checkoutPath),
    )
    const file = path.join(root, 'src/modules.ts')
    const original = fs.readFileSync(file, 'utf8')
    try {
      if (updatedRegistration !== undefined)
        fs.writeFileSync(file, updatedRegistration)
      commit(options.linkedDevelopment)
    } catch (error) {
      if (updatedRegistration !== undefined) fs.writeFileSync(file, original)
      throw error
    }
    return options.linkedDevelopment
  }
  const hadLocalSource = exists(moduleDirectory)
  if (
    (hadLocalSource || !options.registerMissing) &&
    (!hadLocalSource ||
      !fs.lstatSync(moduleDirectory).isDirectory() ||
      !exists(path.join(moduleDirectory, 'index.ts')) ||
      fs.lstatSync(path.join(moduleDirectory, 'index.ts')).isSymbolicLink())
  )
    throw new Error(
      `No local module found at src/modules/${id}/index.ts. Publish or create the local module before linking development.`,
    )
  inspectDevelopmentRepository(root, options.repository, execute, {
    id,
    packageName: options.packageName,
  })
  const repoRoot = realDirectories(root, '.mercato/module-repos', true)
  const backupRoot = realDirectories(root, '.mercato/module-backups', true)
  const checkout = path.join(repoRoot, checkoutName)
  if (exists(checkout))
    throw new Error(
      `.mercato/module-repos/${checkoutName} already exists. Refusing to overwrite a checkout; inspect and move it before retrying.`,
    )
  const staging = fs.mkdtempSync(path.join(repoRoot, `.${id}-`))
  const stagingCheckout = path.join(staging, 'repository')
  let installedCheckout = false
  let movedSource = false
  let installedLink = false
  let changedRegistration = false
  let createdModules = false
  const modulesFile = path.join(root, 'src/modules.ts')
  const originalRegistration = fs.readFileSync(modulesFile, 'utf8')
  let backup = ''
  try {
    execute('gh', ['repo', 'clone', options.repository, stagingCheckout], root)
    const gitRoot = execute(
      'git',
      ['rev-parse', '--show-toplevel'],
      stagingCheckout,
      { capture: true },
    ).stdout.trim()
    if (
      !gitRoot ||
      fs.realpathSync(gitRoot) !== fs.realpathSync(stagingCheckout)
    )
      throw new Error(
        'The module clone did not create an isolated Git repository. The app repository was left unchanged.',
      )
    validateCheckout(
      root,
      path.relative(root, stagingCheckout).split(path.sep).join('/'),
      id,
      options.packageName,
    )
    fs.renameSync(stagingCheckout, checkout)
    installedCheckout = true
    shareDependencies(root, checkout)
    const timestamp = new Date().toISOString().replace(/[^0-9TZ]/g, '')
    const backupContainer = fs.mkdtempSync(
      path.join(backupRoot, `${id}-${timestamp}-`),
    )
    fs.rmdirSync(backupContainer)
    backup = backupContainer
    if (hadLocalSource) {
      fs.renameSync(moduleDirectory, backup)
      movedSource = true
    } else backup = ''
    const source = path.join(checkout, 'src/modules', id)
    if (!exists(modules)) {
      fs.mkdirSync(modules)
      createdModules = true
    }
    fs.symlinkSync(path.relative(modules, source), moduleDirectory, 'dir')
    installedLink = true
    const link: DevelopmentLink = {
      formatVersion: 1,
      repository: options.repository,
      packageName: options.packageName,
      checkoutPath: path.relative(root, checkout).split(path.sep).join('/'),
      sourcePath: path.relative(root, source).split(path.sep).join('/'),
      backupPath: backup
        ? path.relative(root, backup).split(path.sep).join('/')
        : '',
    }
    if (updatedRegistration !== undefined) {
      fs.writeFileSync(modulesFile, updatedRegistration)
      changedRegistration = true
    }
    // Saved inside the rollback scope: a link without metadata cannot be reused.
    commit(link)
    return link
  } catch (error) {
    if (changedRegistration) fs.writeFileSync(modulesFile, originalRegistration)
    if (installedLink) fs.unlinkSync(moduleDirectory)
    if (createdModules) fs.rmdirSync(modules)
    if (movedSource) fs.renameSync(backup, moduleDirectory)
    if (installedCheckout) fs.rmSync(checkout, { recursive: true, force: true })
    throw error
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

export function validateCheckoutName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name))
    throw new Error(
      'Use a local checkout name containing letters, numbers, hyphens or underscores, for example my-visits.',
    )
}
