import type { App, Executor } from './types.js'
import { run, validateId } from './common.js'
import { inspectDevelopmentRepository } from './development.js'
import { githubRepositoryFromInput, npmPackageLocator } from './link.js'
import { parseModuleLocator } from './module-locators.js'
import {
  assertNoModuleCollision,
  missingRequirements,
  requirementsWarning,
} from './requirements.js'

export interface InstallOptions {
  eject?: boolean
  expectedPackage?: string
  moduleId?: string
  ref?: string
  warn?: (message: string) => void
  approveGitRepository?: boolean
}

export class GitRepositoryApprovalRequired extends Error {
  constructor(readonly repository: string, cause?: unknown) {
    super(`🔒 Yarn blocked this repository because it is not in approvedGitRepositories.\n\n🐙 Repository: https://github.com/${repository}.git\n📝 Approval adds only this exact URL to this app's Yarn configuration and retries installation. Existing approvals are preserved.\n\nApprove interactively or pass --approve-git-repository for this installation.`, { cause })
    this.name = 'GitRepositoryApprovalRequired'
  }
}

export interface InstalledModule {
  commit?: string
  missingRequirements?: string[]
  packageName: string
  repository?: string
  specifier: string
}

function validGitRef(value: string): boolean {
  return value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
}

function repositoryCommit(
  app: App,
  repository: string,
  execute: Executor,
  requestedRef?: string,
  versionTag?: string,
): string {
  let ref = requestedRef
  if (ref && !validGitRef(ref))
    throw new Error(
      'Use a valid Git tag, branch, or commit SHA for --ref. No files were changed.',
    )
  if (!ref) {
    const details = execute(
      'gh',
      ['api', `repos/${repository}`],
      app.directory,
      { capture: true },
    )
    let branch: unknown
    try {
      branch = JSON.parse(details.stdout).default_branch
    } catch {}
    if (typeof branch !== 'string' || !validGitRef(branch))
      throw new Error(
        `🐙 Cannot determine ${repository}'s default branch. No files were changed.`,
      )
    ref = branch
  }
  const lookup = (selectedRef: string) =>
    execute(
      'gh',
      [
        'api',
        `repos/${repository}/commits/${encodeURIComponent(selectedRef)}`,
        '--jq',
        '.sha',
      ],
      app.directory,
      { capture: true, allowFailure: true },
    )
  let result = lookup(ref)
  // Preserve exact refs; only a missing numeric @version may try its release tag.
  const refMissing =
    /\bHTTP 404\b/.test(result.stderr) ||
    (/\bHTTP 422\b/.test(result.stderr) &&
      /No commit found for SHA:/.test(result.stderr))
  if (result.status !== 0 && refMissing && versionTag)
    result = lookup(versionTag)
  const commit = result.stdout.trim()
  if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(commit))
    throw new Error(
      `🐙 Cannot resolve ${repository}'s ${requestedRef ? `ref ${requestedRef}${versionTag ? ` or tag ${versionTag}` : ''}` : 'default branch'} to a commit. Check the ref, gh auth status, and network access, then retry. No files were changed.`,
    )
  return commit
}

function assertPackageName(packageName: string): string {
  const locator = npmPackageLocator(
    packageName.startsWith('@') ? packageName : `npm:${packageName}`,
  )
  if (!locator || locator.specifier !== locator.packageName)
    throw new Error(
      'Use a valid npm package name for --package, without a version or tag.',
    )
  return locator.packageName
}

function mercatoArguments(
  action: 'add' | 'enable',
  value: string,
  options: InstallOptions,
): string[] {
  const args = ['mercato', 'module', action, value, '--allow-third-party']
  if (options.moduleId) args.push('--module', validateId(options.moduleId))
  if (options.eject) args.push('--eject')
  return args
}

// The underlying command already printed its own error; this adds what the
// installer knows about the state it left and about unmet requirements.
function withContext(error: unknown, ...context: string[]): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error([message, ...context].join('\n\n'), { cause: error })
}

export function installFromInput(
  app: App,
  input: string,
  options: InstallOptions = {},
  execute: Executor = run,
): InstalledModule {
  if (options.moduleId) validateId(options.moduleId)
  const warn = options.warn ?? ((message) => console.log(`\n${message}`))
  const missing = (packageName: string) =>
    missingRequirements(app.directory, packageName, options.moduleId)
  const expectedPackage = options.expectedPackage
    ? assertPackageName(options.expectedPackage)
    : undefined
  const npm = npmPackageLocator(input)
  if (npm) {
    if (options.ref)
      throw new Error(
        '--ref is only available for GitHub repository locators. No files were changed.',
      )
    if (expectedPackage && expectedPackage !== npm.packageName)
      throw new Error(
        `The requested npm package ${npm.packageName} does not match --package ${expectedPackage}. No files were changed.`,
      )
    // Open Mercato installs and enables in one step, so requirements can
    // only be read once the package is on disk.
    try {
      execute(
        'yarn',
        mercatoArguments('add', npm.specifier, options),
        app.directory,
      )
    } catch (error) {
      const required = missing(npm.packageName)
      if (!required.length) throw error
      throw withContext(error, requirementsWarning(npm.packageName, required))
    }
    const required = missing(npm.packageName)
    if (required.length) warn(requirementsWarning(npm.packageName, required))
    return {
      packageName: npm.packageName,
      specifier: npm.specifier,
      ...(required.length ? { missingRequirements: required } : {}),
    }
  }

  const parsed = parseModuleLocator(input)
  const hashIndex = input.indexOf('#')
  const atIndex = input.lastIndexOf('@')
  const refIndex =
    hashIndex >= 0 ? hashIndex : atIndex > input.indexOf('/') ? atIndex : -1
  const locatorRef = refIndex >= 0 ? input.slice(refIndex + 1) : undefined
  if (hashIndex !== input.lastIndexOf('#') || locatorRef === '')
    throw new Error('Use one non-empty Git ref after #. No files were changed.')
  if (locatorRef && options.ref && locatorRef !== options.ref)
    throw new Error(
      'The locator ref does not match --ref. No files were changed.',
    )
  const repositoryInput =
    parsed?.kind === 'github' ? parsed.identity.slice('github:'.length) : input
  const repository = githubRepositoryFromInput(app, repositoryInput, execute)
  const versionTag =
    hashIndex < 0 &&
    !options.ref &&
    locatorRef &&
    /^\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/.test(locatorRef)
      ? `v${locatorRef}`
      : undefined
  const commit = repositoryCommit(
    app,
    repository,
    execute,
    options.ref ?? locatorRef,
    versionTag,
  )
  const manifest = inspectDevelopmentRepository(
    app.directory,
    repository,
    execute,
    undefined,
    commit,
  )
  const packageName = assertPackageName(manifest.name)
  if (expectedPackage && expectedPackage !== packageName)
    throw new Error(
      `🐙 ${repository} holds ${packageName}, not ${expectedPackage}. Choose the package's dedicated module repository. No files were changed.`,
    )
  assertNoModuleCollision(
    app.directory,
    validateId(options.moduleId ?? manifest.mercatoModule.id),
    packageName,
    repository,
  )
  const specifier = `${packageName}@github:${repository}#${commit}`
  const add = () => {
    const result = execute('yarn', ['add', specifier], app.directory, { capture: true })
    if (result.stdout) console.log(result.stdout.trimEnd())
    if (result.stderr) console.error(result.stderr.trimEnd())
  }
  try {
    add()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const url = `https://github.com/${repository}.git`
    if (!message.includes('YN0080') || !message.includes('approvedGitRepositories') || !message.includes(url))
      throw error
    if (!options.approveGitRepository) throw new GitRepositoryApprovalRequired(repository, error)
    const result = execute('yarn', ['config', 'get', 'approvedGitRepositories', '--json'], app.directory, { capture: true })
    let approved: unknown
    try { approved = JSON.parse(result.stdout) } catch {}
    if (!Array.isArray(approved) || !approved.every(value => typeof value === 'string'))
      throw new Error('Cannot read approvedGitRepositories safely. Yarn configuration was not changed.', { cause: error })
    if (approved.includes(url)) throw error
    execute('yarn', ['config', 'set', 'approvedGitRepositories', '--json', JSON.stringify([...approved, url])], app.directory)
    warn(`✅ Added ${url} to this app's approvedGitRepositories. Retrying installation.`)
    // Installation can outlast a captured probe; show progress and wait for Yarn.
    execute('yarn', ['add', specifier], app.directory)
  }
  const required = missing(packageName)
  if (required.length) warn(requirementsWarning(packageName, required))
  try {
    execute(
      'yarn',
      mercatoArguments('enable', packageName, options),
      app.directory,
    )
  } catch (error) {
    throw withContext(
      error,
      `${packageName} was added to package.json but is not enabled. Fix the error above, then run install again.`,
      ...(required.length ? [requirementsWarning(packageName, required)] : []),
    )
  }
  return {
    commit,
    packageName,
    repository,
    specifier,
    ...(required.length ? { missingRequirements: required } : {}),
  }
}
