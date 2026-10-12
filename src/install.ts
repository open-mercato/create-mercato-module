import type { App, Executor } from './types.js'
import { run, validateId } from './common.js'
import { inspectDevelopmentRepository } from './development.js'
import {
  githubRepositoryFromInput,
  npmPackageLocator,
} from './link.js'

export interface InstallOptions {
  eject?: boolean
  expectedPackage?: string
  moduleId?: string
  ref?: string
}

export interface InstalledModule {
  commit?: string
  packageName: string
  repository?: string
  specifier: string
}

function validGitRef(value: string): boolean {
  return (
    value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
  )
}

function repositoryCommit(
  app: App,
  repository: string,
  execute: Executor,
  requestedRef?: string,
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
  const result = execute(
    'gh',
    [
      'api',
      `repos/${repository}/commits/${encodeURIComponent(ref)}`,
      '--jq',
      '.sha',
    ],
    app.directory,
    { capture: true },
  )
  const commit = result.stdout.trim()
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw new Error(
      `🐙 Cannot resolve ${repository}'s ${requestedRef ? `ref ${requestedRef}` : 'default branch'} to a commit. No files were changed.`,
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

export function installFromInput(
  app: App,
  input: string,
  options: InstallOptions = {},
  execute: Executor = run,
): InstalledModule {
  if (options.moduleId) validateId(options.moduleId)
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
    execute(
      'yarn',
      mercatoArguments('add', npm.specifier, options),
      app.directory,
    )
    return { packageName: npm.packageName, specifier: npm.specifier }
  }

  const repository = githubRepositoryFromInput(app, input, execute)
  const commit = repositoryCommit(
    app,
    repository,
    execute,
    options.ref,
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
  const specifier = `${packageName}@github:${repository}#${commit}`
  execute('yarn', ['add', specifier], app.directory)
  execute(
    'yarn',
    mercatoArguments('enable', packageName, options),
    app.directory,
  )
  return { commit, packageName, repository, specifier }
}
