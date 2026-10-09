import type { App, SavedSettings, Settings } from './types.js'
import { run, validateId } from './common.js'
import { loadConfig, saveDevelopment } from './config.js'
import {
  inspectDevelopmentRepository,
  linkDevelopment,
  validateCheckoutName,
} from './development.js'
import { createNpmRunner, resolveRegistry } from './npm-auth.js'
import { validateSettings } from './package.js'

// Normalize only repository roots. A tree/blob URL or another host is not a
// dedicated repository locator, and must never silently select different code.
export function githubRepository(input: string): string {
  const repository = input
    .trim()
    .replace(/^(?:(?:git\+)?https:\/\/github\.com\/)+/i, '')
    .replace(/^github\.com\//i, '')
    .replace(/^github:/i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^ssh:\/\/git@github\.com\//i, '')
    .replace(/\/$/, '')
    .replace(/\.git$/, '')
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository)
  )
    throw new Error(
      'Use a GitHub repository URL or owner/repo, for example https://github.com/pkarw/visits-example.',
    )
  return repository
}

function npmRepository(
  app: App,
  specifier: string,
): { repository: string; packageName: string } {
  const match =
    /^(?<name>(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:@(?<version>[a-zA-Z0-9][a-zA-Z0-9._-]*))?$/.exec(
      specifier,
    )
  if (!match?.groups || match.groups.name.length > 214)
    throw new Error(
      'Use an npm package name, for example @piotrkarwatka/visits.',
    )
  const packageName = match.groups.name
  const registry = resolveRegistry()
  // Public lookups need no login. Reuse an explicit environment token for
  // private packages without putting credentials in arguments or app files.
  const npm = createNpmRunner(
    process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN ? 'token' : 'login',
    run,
    process.env,
    packageName,
  )
  let result: ReturnType<typeof run>
  try {
    result = npm.execute(
      'npm',
      ['view', specifier, 'repository', '--json', `--registry=${registry}`],
      app.directory,
      { capture: true, allowFailure: true },
    )
  } finally {
    npm.close()
  }
  if (result.status !== 0)
    throw new Error(
      `📦 Cannot read ${specifier} from npm. Check the package name, npm access and network connection, or link its GitHub URL directly. No files were changed.`,
    )
  let metadata: unknown
  try {
    metadata = JSON.parse(result.stdout)
  } catch {}
  const url =
    typeof metadata === 'string'
      ? metadata
      : metadata &&
          typeof metadata === 'object' &&
          'url' in metadata &&
          typeof metadata.url === 'string'
        ? metadata.url
        : ''
  try {
    if (
      metadata &&
      typeof metadata === 'object' &&
      'directory' in metadata &&
      metadata.directory &&
      metadata.directory !== '.'
    )
      throw new Error('monorepo')
    return { repository: githubRepository(url), packageName }
  } catch {
    throw new Error(
      `📦 ${packageName} has no dedicated GitHub module repository in its npm metadata. Ask its author to set package.json repository to the module's own GitHub repository, or link that repository URL directly. No files were changed.`,
    )
  }
}

export function linkFromInput(
  app: App,
  input: string,
  localName?: string,
  flags: Record<string, string | boolean> = {},
) {
  if (localName) validateCheckoutName(localName)
  const config = loadConfig(app)
  const saved = config.modules[input]
  let repositoryInput = String(flags.repo || '') || saved?.repository || input
  let expectedPackage = String(flags.package || '') || undefined
  if (repositoryInput.startsWith('@') || repositoryInput.startsWith('npm:')) {
    const npm = npmRepository(app, repositoryInput.replace(/^npm:/, ''))
    repositoryInput = npm.repository
    if (expectedPackage && expectedPackage !== npm.packageName)
      throw new Error(
        `The requested npm package ${npm.packageName} does not match --package ${expectedPackage}. No files were changed.`,
      )
    expectedPackage = npm.packageName
  }
  if (
    run('gh', ['auth', 'status'], app.directory, {
      capture: true,
      allowFailure: true,
    }).status !== 0
  )
    throw new Error(
      '🔐 Sign in to GitHub with gh auth login, then retry. No files were changed.',
    )
  // A bare repository name belongs to the authenticated GitHub user. Saved
  // module settings take precedence so the original `link visits` keeps working.
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repositoryInput)) {
    const user = run('gh', ['api', 'user'], app.directory, { capture: true })
    let login: unknown
    try {
      login = JSON.parse(user.stdout).login
    } catch {}
    if (typeof login !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(login))
      throw new Error(
        'Cannot determine your GitHub account. Use owner/repo or a full GitHub URL.',
      )
    repositoryInput = `${login}/${repositoryInput}`
  }
  const repository = githubRepository(repositoryInput)
  const manifest = inspectDevelopmentRepository(app.directory, repository, run)
  const id = validateId(manifest.mercatoModule.id)
  if (expectedPackage && expectedPackage !== manifest.name)
    throw new Error(
      `🐙 ${repository} holds ${manifest.name}, not ${expectedPackage}. Choose the package's dedicated module repository. No files were changed.`,
    )
  if (
    flags.repo &&
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(input) &&
    input !== id
  )
    throw new Error(
      `🐙 ${repository} contains module ${id}, not ${input}. Run link ${repository} instead. No files were changed.`,
    )
  const previous: Partial<SavedSettings> = config.modules[id] || {}
  if (
    previous.development &&
    (previous.development.repository !== repository ||
      previous.development.packageName !== manifest.name)
  )
    throw new Error(
      `Module ${id} is already linked to ${previous.development.repository}. Keep or unlink that checkout before linking another repository. No files were changed.`,
    )
  const settings: Settings = {
    packageName: manifest.name,
    repository,
    version: previous.lastPublishedVersion || manifest.version || '0.1.0',
    access: previous.access || manifest.publishConfig?.access || 'public',
    auth: previous.auth || 'auto',
    ...(previous.tag ? { tag: previous.tag } : {}),
  }
  validateSettings(settings)
  const development = linkDevelopment(
    app,
    id,
    {
      repository,
      packageName: manifest.name,
      checkoutName: localName,
      linkedDevelopment: previous.development,
      registerMissing: true,
    },
    run,
    (link) => saveDevelopment(app, id, link, settings),
  )
  return { id, development }
}
