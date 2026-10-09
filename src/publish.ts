import type { App, Settings, ExportedPackage, Executor } from './types.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { readJson, writeJson, run, within } from './common.js'
import { preparePackage } from './package.js'
import { createNpmRunner } from './npm-auth.js'
import { linkedModuleDirectory } from './development.js'
import type { DevelopmentLink } from './development.js'
import {
  validateMutablePaths,
  repositoryFingerprint,
  assertNoCredentials,
} from './repository-safety.js'

function exportPackage(
  app: App,
  id: string,
  settings: Settings,
): ExportedPackage {
  const root = path.join(app.directory, '.mercato/module-publish')
  fs.mkdirSync(root, { recursive: true })
  if (!within(app.directory, fs.realpathSync(root)))
    throw new Error(
      'The .mercato export directory must remain inside the application.',
    )
  const workspace = fs.mkdtempSync(path.join(root, `${id}-`))
  const result = preparePackage(
    app,
    id,
    settings,
    path.join(workspace, 'package'),
  )
  return packPrepared(result, workspace)
}

function packPrepared(
  result:
    | ExportedPackage
    | Omit<ExportedPackage, 'workspace' | 'archive' | 'integrity'>,
  workspace: string,
): ExportedPackage {
  const packed = run(
    'npm',
    ['pack', '--json', '--ignore-scripts'],
    result.destination,
    { capture: true },
  )
  const entries: {
    filename: string
    integrity: string
    files: { path: string }[]
  }[] = JSON.parse(packed.stdout)
  if (
    entries.length !== 1 ||
    !entries[0].filename ||
    path.basename(entries[0].filename) !== entries[0].filename
  )
    throw new Error('npm pack did not produce one package archive.')
  for (const file of entries[0].files) {
    if (
      !/^(?:src\/|dist\/|types\/|package\.json$|build\.cjs$|README\.md$|LICENSE$)/.test(
        file.path,
      )
    )
      throw new Error(`Unexpected file in npm package: ${file.path}`)
  }
  return {
    ...result,
    workspace,
    archive: path.join(result.destination, entries[0].filename),
    integrity: entries[0].integrity,
  }
}

function exportLinkedPackage(
  app: App,
  id: string,
  settings: Settings,
  metadata: DevelopmentLink,
): ExportedPackage {
  if (
    metadata.repository !== settings.repository ||
    metadata.packageName !== settings.packageName
  )
    throw new Error(
      'The publish settings must match the linked module repository and npm package. Use the saved settings or unlink development first.',
    )
  const source = linkedModuleDirectory(app, id, metadata)
  const checkout = path.join(app.directory, metadata.checkoutPath)
  assertLinkedRepository(checkout, settings)
  if (
    !fs.existsSync(path.join(checkout, 'src/index.ts')) ||
    !fs.lstatSync(path.join(checkout, 'src/index.ts')).isFile()
  )
    throw new Error(
      'The module repository is missing src/index.ts. Restore its package entry point before publishing.',
    )
  const fingerprint = repositoryFingerprint(checkout, id)
  const root = path.join(app.directory, '.mercato/module-publish')
  fs.mkdirSync(root, { recursive: true })
  if (!within(app.directory, fs.realpathSync(root)))
    throw new Error('The export directory must remain inside the app.')
  const workspace = fs.mkdtempSync(path.join(root, `${id}-`))
  const prepared = preparePackage(
    app,
    id,
    settings,
    path.join(workspace, 'package'),
    source,
  )
  const original = readJson<Record<string, unknown>>(
    path.join(checkout, 'package.json'),
  )
  assertNoCredentials(
    'package.json',
    fs.readFileSync(path.join(checkout, 'package.json'), 'utf8'),
  )
  if (original.private === true)
    throw new Error(
      'This module repository is marked private: true in package.json, which blocks npm publication. Remove that field to publish; use --access restricted for a private npm package.',
    )
  const manifest = { ...original, ...prepared.manifest }
  for (const field of [
    'description',
    'license',
    'author',
    'keywords',
    'homepage',
    'bugs',
  ]) {
    if (original[field] !== undefined)
      (manifest as Record<string, unknown>)[field] = original[field]
  }
  for (const field of [
    'dependencies',
    'peerDependencies',
    'devDependencies',
    'scripts',
  ] as const) {
    const previous = original[field]
    const current = prepared.manifest[field]
    if (
      typeof previous === 'object' &&
      previous !== null &&
      !Array.isArray(previous)
    )
      manifest[field] = { ...previous, ...current }
  }
  writeJson(path.join(prepared.destination, 'package.json'), manifest)
  for (const name of [
    'README.md',
    'LICENSE',
    '.github/workflows/publish.yml',
  ]) {
    const file = path.join(checkout, name)
    if (fs.existsSync(file)) {
      if (
        fs.lstatSync(file).isSymbolicLink() ||
        !within(checkout, fs.realpathSync(file))
      )
        throw new Error(`Refusing to package repository symlink: ${name}`)
      const content = fs.readFileSync(file)
      if (
        /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,})/.test(
          content.toString('utf8'),
        )
      )
        throw new Error(
          `Possible credential in repository file ${name}. Remove it before publishing.`,
        )
      fs.copyFileSync(file, path.join(prepared.destination, name))
    }
  }
  if (repositoryFingerprint(checkout, id) !== fingerprint)
    throw new Error(
      'The module changed while packaging. Retry to build one consistent release.',
    )
  return {
    ...packPrepared({ ...prepared, manifest }, workspace),
    linkedCheckout: checkout,
    linkedFingerprint: fingerprint,
  }
}

function assertLinkedRepository(
  checkout: string,
  settings: Settings,
  execute: Executor = run,
): void {
  const gitRoot = execute('git', ['rev-parse', '--show-toplevel'], checkout, {
    capture: true,
  }).stdout.trim()
  if (fs.realpathSync(gitRoot) !== fs.realpathSync(checkout))
    throw new Error(
      'The linked module must be its own Git repository. The app repository was left unchanged.',
    )
  const remote = execute('git', ['remote', 'get-url', 'origin'], checkout, {
    capture: true,
  }).stdout.trim()
  const identity = remote
    .replace(/^git@github\.com:/, '')
    .replace(/^(?:git\+)?https:\/\/github\.com\//, '')
    .replace(/^ssh:\/\/git@github\.com\//, '')
    .replace(/\.git$/, '')
  if (identity.toLowerCase() !== settings.repository?.toLowerCase())
    throw new Error(
      'The linked repository origin does not match the saved GitHub repository. Check git remote -v in the module checkout.',
    )
  if (
    execute('git', ['symbolic-ref', '--quiet', 'HEAD'], checkout, {
      capture: true,
      allowFailure: true,
    }).status !== 0
  )
    throw new Error(
      'The module checkout is on a detached commit. Check out a branch before publishing.',
    )
}

function publishLinkedRepository(
  prepared: ExportedPackage,
  settings: Settings,
  execute: Executor,
): void {
  const checkout = prepared.linkedCheckout!
  assertLinkedRepository(checkout, settings, execute)
  const id = prepared.manifest.mercatoModule.id
  if (
    !prepared.linkedFingerprint ||
    repositoryFingerprint(checkout, id) !== prepared.linkedFingerprint
  )
    throw new Error(
      'The module changed after the archive was prepared. Retry publish to include the latest edits; no files were changed.',
    )
  const owned = [
    `src/modules/${id}`,
    'src/index.ts',
    'src/.npmignore',
    `dist/modules/${id}`,
    'dist/index.js',
    'types',
    'package.json',
    'build.cjs',
    'README.md',
    '.github/workflows/publish.yml',
  ]
  if (fs.existsSync(path.join(prepared.destination, 'LICENSE')))
    owned.push('LICENSE')
  const staged = execute(
    'git',
    ['diff', '--cached', '--name-only', '-z'],
    checkout,
    { capture: true },
  )
    .stdout.split('\0')
    .filter(Boolean)
  if (
    staged.some(
      (file) =>
        !owned.some((name) => file === name || file.startsWith(`${name}/`)),
    )
  )
    throw new Error(
      'The module repository has staged files outside the release paths. Commit or unstage them before publishing; no files were changed.',
    )
  validateMutablePaths(checkout, owned)
  ensureAuthor(checkout, execute)
  for (const name of owned.filter(
    (name) => !name.startsWith('src/') || name === 'src/.npmignore',
  )) {
    const target = path.join(checkout, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (name === `dist/modules/${id}` || name === 'types') {
      fs.rmSync(target, { recursive: true, force: true })
      fs.cpSync(path.join(prepared.destination, name), target, {
        recursive: true,
      })
    } else fs.copyFileSync(path.join(prepared.destination, name), target)
  }
  execute('git', ['add', '--', ...owned], checkout)
  if (
    execute('git', ['diff', '--cached', '--quiet'], checkout, {
      capture: true,
      allowFailure: true,
    }).status !== 0
  )
    execute(
      'git',
      ['commit', '-m', `Release ${settings.packageName}@${settings.version}`],
      checkout,
    )
  execute('git', ['push', '-u', 'origin', 'HEAD'], checkout)
}

function githubState(repository: string, cwd: string, execute: Executor = run) {
  const result = execute('gh', ['api', `repos/${repository}`], cwd, {
    capture: true,
    allowFailure: true,
  })
  if (result.status === 0) return 'exists'
  if (/HTTP 404/.test(result.stderr || '')) return 'missing'
  throw new Error(
    'Cannot inspect the GitHub repository. Check gh auth login and network access; no repository was created.',
  )
}

function publishRepository(
  prepared: ExportedPackage,
  settings: Settings,
  execute: Executor = run,
) {
  if (prepared.linkedCheckout)
    return publishLinkedRepository(prepared, settings, execute)
  const state = githubState(settings.repository!, prepared.workspace, execute)
  if (state === 'missing')
    execute(
      'gh',
      [
        'repo',
        'create',
        settings.repository!,
        settings.access === 'public' ? '--public' : '--private',
        '--description',
        `Open Mercato module: ${prepared.manifest.mercatoModule.id}`,
      ],
      prepared.workspace,
    )
  const checkout = path.join(prepared.workspace, 'repository')
  execute(
    'gh',
    ['repo', 'clone', settings.repository!, checkout],
    prepared.workspace,
  )
  const gitRoot = execute('git', ['rev-parse', '--show-toplevel'], checkout, {
    capture: true,
  }).stdout.trim()
  if (fs.realpathSync(gitRoot) !== fs.realpathSync(checkout))
    throw new Error(
      'Refusing to use the application repository for module publication.',
    )
  const hasHead =
    execute('git', ['rev-parse', '--verify', 'HEAD'], checkout, {
      capture: true,
      allowFailure: true,
    }).status === 0
  if (hasHead) {
    const packageFile = path.join(checkout, 'package.json')
    if (
      !fs.existsSync(packageFile) ||
      fs.lstatSync(packageFile).isSymbolicLink()
    )
      throw new Error(
        'The GitHub repository is not a package created by this tool. Choose a new repository.',
      )
    const manifest = readJson(packageFile)
    if (
      manifest.name !== settings.packageName ||
      manifest.mercatoModule?.id !== prepared.manifest.mercatoModule.id ||
      manifest.mercatoModule?.formatVersion !== 1
    )
      throw new Error(
        'The GitHub repository belongs to another package/module. Choose a different repository.',
      )
  } else execute('git', ['checkout', '-b', 'main'], checkout)
  ensureAuthor(checkout, execute)
  const owned = [
    'src',
    'dist',
    'types',
    'package.json',
    'build.cjs',
    'README.md',
    '.gitignore',
    '.github/workflows/publish.yml',
  ]
  validateMutablePaths(checkout, owned)
  for (const name of owned) {
    const destination = path.join(checkout, name)
    fs.rmSync(destination, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.cpSync(path.join(prepared.destination, name), destination, {
      recursive: true,
    })
  }
  execute('git', ['add', '--', ...owned], checkout)
  if (
    execute('git', ['diff', '--cached', '--quiet'], checkout, {
      capture: true,
      allowFailure: true,
    }).status !== 0
  ) {
    execute(
      'git',
      ['commit', '-m', `Release ${settings.packageName}@${settings.version}`],
      checkout,
    )
  }
  execute('git', ['push', '-u', 'origin', 'HEAD'], checkout)
}

function ensureAuthor(checkout: string, execute: Executor): void {
  const identity = execute('git', ['var', 'GIT_AUTHOR_IDENT'], checkout, {
    capture: true,
    allowFailure: true,
  })
  if (identity.status !== 0) {
    const user: { login: string; id: number } = JSON.parse(
      execute('gh', ['api', 'user'], checkout, { capture: true }).stdout,
    )
    if (!/^[a-zA-Z0-9-]+$/.test(user.login) || !Number.isSafeInteger(user.id))
      throw new Error('GitHub returned an invalid author identity.')
    execute('git', ['config', 'user.name', user.login], checkout)
    execute(
      'git',
      [
        'config',
        'user.email',
        `${user.id}+${user.login}@users.noreply.github.com`,
      ],
      checkout,
    )
  }
}

function preflight(
  prepared: ExportedPackage,
  settings: Settings,
  execute: Executor = run,
  authMode = 'login',
) {
  if (authMode === 'trusted') {
    const version = execute('npm', ['--version'], prepared.destination, {
      capture: true,
    })
      .stdout.trim()
      .split('.')
      .map(Number)
    if (
      version[0] < 11 ||
      (version[0] === 11 &&
        (version[1] < 5 || (version[1] === 5 && version[2] < 1)))
    )
      throw new Error(
        'Trusted publishing requires npm 11.5.1 or newer. Upgrade npm in your GitHub Actions job.',
      )
    if (
      process.env.GITHUB_REPOSITORY &&
      prepared.manifest.repository?.url !==
        `git+https://github.com/${process.env.GITHUB_REPOSITORY}.git`
    )
      throw new Error(
        'The package repository must match the GitHub Actions repository for trusted publishing. Publish from the dedicated module repository using its publish.yml workflow, or omit --repo for app-repository CI publication.',
      )
  } else if (
    execute('npm', ['whoami'], prepared.destination, {
      capture: true,
      allowFailure: true,
    }).status !== 0
  )
    throw new Error(
      authMode === 'token'
        ? 'npm rejected the token. Check its expiry, package permissions, and npm scope. No external changes were made.'
        : 'Log in with npm login, then run publish again, or set NPM_TOKEN and use --auth token. No external changes were made.',
    )
  const version = execute(
    'npm',
    [
      'view',
      `${settings.packageName}@${settings.version}`,
      'version',
      '--json',
    ],
    prepared.destination,
    { capture: true, allowFailure: true },
  )
  if (version.status === 0 && version.stdout.trim())
    throw new Error(
      'This npm version is already published. Choose a new --version.',
    )
  if (
    version.status !== 0 &&
    !/E404/.test(`${version.stdout}\n${version.stderr}`)
  )
    throw new Error(
      'Cannot verify the npm version. Check registry/network access and retry.',
    )
  if (
    settings.repository &&
    execute('gh', ['auth', 'status'], prepared.workspace, {
      capture: true,
      allowFailure: true,
    }).status !== 0
  )
    throw new Error(
      'Log in with gh auth login, then run publish again. No external changes were made.',
    )
}

function publish(
  prepared: ExportedPackage,
  settings: Settings,
  execute: Executor = run,
) {
  const npm = createNpmRunner(settings.auth || 'auto', execute)
  try {
    preflight(prepared, settings, npm.execute, npm.mode)
    if (settings.repository) publishRepository(prepared, settings, execute)
    npm.execute(
      'npm',
      [
        'publish',
        prepared.archive,
        '--access',
        settings.access,
        '--ignore-scripts',
        ...((settings.tag ||
          (settings.version.includes('-') ? 'next' : 'latest')) !== 'latest'
          ? ['--tag', settings.tag || 'next']
          : []),
      ],
      prepared.destination,
    )
  } finally {
    npm.close()
  }
}

export { loadConfig, saveConfig } from './config.js'

export {
  exportPackage,
  githubState,
  publishRepository,
  preflight,
  publish,
  exportLinkedPackage,
}
