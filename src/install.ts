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
  preapprovePackage?: boolean
}

export class GitRepositoryApprovalRequired extends Error {
  constructor(readonly repository: string, cause?: unknown) {
    super(`🔒 Yarn blocked this repository because it is not in approvedGitRepositories.\n\n🐙 Repository: https://github.com/${repository}.git\n📝 Approval adds only this exact URL to this app's Yarn configuration and retries installation. Existing approvals are preserved.\n\nApprove interactively or pass --approve-git-repository for this installation.`, { cause })
    this.name = 'GitRepositoryApprovalRequired'
  }
}

export class PackageQuarantined extends Error {
  constructor(
    readonly packageName: string,
    version: string,
    wait: string,
    cause?: unknown,
  ) {
    super(`⏳ Yarn in this app installs npm versions only ${wait} after publication (npmMinimalAgeGate), and ${packageName}@${version} is newer.\n\n📝 Preapproval adds only ${packageName} to this app's npmPreapprovedPackages and retries installation; existing entries are kept, and later versions of ${packageName} install without the wait.\n\nApprove interactively, pass --preapprove-package for this installation, or wait until the version is ${wait} old.`, { cause })
    this.name = 'PackageQuarantined'
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

function yarnJson(
  app: App,
  args: string[],
  execute: Executor,
): unknown {
  const result = execute('yarn', args, app.directory, {
    capture: true,
    allowFailure: true,
  })
  if (result.status !== 0) return undefined
  try {
    return JSON.parse(result.stdout)
  } catch {
    return undefined
  }
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined
}

// Yarn matches preapproval entries as globs on the package name.
function preapproved(patterns: string[], packageName: string): boolean {
  return patterns.some((pattern) =>
    new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    ).test(packageName),
  )
}

function waitLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
  return `${minutes} minutes`
}

// Explains a failed npm installation when Yarn's release-age gate held back the
// requested version. Anything it cannot confirm leaves the original error alone.
function quarantine(
  app: App,
  packageName: string,
  specifier: string,
  execute: Executor,
  cause: unknown,
): PackageQuarantined | undefined {
  const gate = yarnJson(app, ['config', 'get', 'npmMinimalAgeGate', '--json'], execute)
  if (typeof gate !== 'number' || !(gate > 0)) return undefined
  const approved = stringList(
    yarnJson(app, ['config', 'get', 'npmPreapprovedPackages', '--json'], execute),
  )
  if (!approved || preapproved(approved, packageName)) return undefined
  const info = yarnJson(
    app,
    ['npm', 'info', packageName, '--fields', 'time,dist-tags', '--json'],
    execute,
  ) as { time?: Record<string, string>; 'dist-tags'?: Record<string, string> } | undefined
  const requested = specifier.slice(packageName.length + 1)
  const version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requested)
    ? requested
    : info?.['dist-tags']?.[requested || 'latest']
  const published = version ? Date.parse(info?.time?.[version] ?? '') : NaN
  if (!version || !(Date.now() - published < gate * 60_000)) return undefined
  return new PackageQuarantined(packageName, version, waitLabel(gate), cause)
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

// The ref suffix of a GitHub locator: `#ref` (always exact) or `@ref`. URL
// prefixes are removed first, so the `git@` user of an SSH URL is never a ref.
export function locatorRefOf(input: string): { ref?: string; exact: boolean } {
  const locator = input
    .trim()
    .replace(/^(?:git\+)?ssh:\/\/(?:[^@/]+@)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/^(?:(?:git\+)?https?:\/\/github\.com\/)+/i, '')
    .replace(/^github:/i, '')
    .replace(/^github\.com\//i, '')
  const hashIndex = locator.indexOf('#')
  const refIndex = hashIndex >= 0 ? hashIndex : locator.lastIndexOf('@')
  const ref = refIndex >= 0 ? locator.slice(refIndex + 1) : undefined
  if (hashIndex !== locator.lastIndexOf('#') || ref === '')
    throw new Error('Use one non-empty Git ref after #. No files were changed.')
  return { ref, exact: hashIndex >= 0 }
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
    const add = () =>
      execute(
        'yarn',
        mercatoArguments('add', npm.specifier, options),
        app.directory,
      )
    try {
      try {
        add()
      } catch (error) {
        const held = quarantine(app, npm.packageName, npm.specifier, execute, error)
        if (!held) throw error
        if (!options.preapprovePackage) throw held
        const approved = stringList(
          yarnJson(app, ['config', 'get', 'npmPreapprovedPackages', '--json'], execute),
        )
        if (!approved)
          throw new Error(
            'Cannot read npmPreapprovedPackages safely. Yarn configuration was not changed.',
            { cause: error },
          )
        execute(
          'yarn',
          ['config', 'set', 'npmPreapprovedPackages', '--json', JSON.stringify([...approved, npm.packageName])],
          app.directory,
        )
        warn(`✅ Added ${npm.packageName} to this app's npmPreapprovedPackages. Retrying installation.`)
        add()
      }
    } catch (error) {
      const required = missing(npm.packageName)
      if (!required.length || error instanceof PackageQuarantined) throw error
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
  const { ref: locatorRef, exact } = locatorRefOf(input)
  if (locatorRef && options.ref && locatorRef !== options.ref)
    throw new Error(
      'The locator ref does not match --ref. No files were changed.',
    )
  const repositoryInput =
    parsed?.kind === 'github' ? parsed.identity.slice('github:'.length) : input
  const repository = githubRepositoryFromInput(app, repositoryInput, execute)
  const versionTag =
    !exact &&
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
