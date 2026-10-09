import type { Executor, RunOptions, Settings } from './types.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { run } from './common.js'

const registry = 'https://registry.npmjs.org/'

function resolveAuth(
  requested = 'auto',
  environment: NodeJS.ProcessEnv = process.env,
) {
  const oidc =
    environment.GITHUB_ACTIONS === 'true' &&
    environment.ACTIONS_ID_TOKEN_REQUEST_URL &&
    environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  const token = environment.NPM_TOKEN || environment.NODE_AUTH_TOKEN
  const mode =
    requested === 'auto'
      ? token
        ? 'token'
        : oidc
          ? 'trusted'
          : 'login'
      : requested
  if (!['login', 'token', 'trusted'].includes(mode))
    throw new Error('Choose npm auth: auto, login, token, or trusted.')
  if (mode === 'token' && !token)
    throw new Error(
      'npm token missing. Set NPM_TOKEN or NODE_AUTH_TOKEN in your environment, then retry with --auth token. Never pass a token in a command argument or commit it to the app.',
    )
  if (mode === 'trusted' && !oidc)
    throw new Error(
      'Trusted publishing needs a GitHub-hosted Actions job with id-token: write. Configure the npm trusted publisher for this repository and workflow. Locally, use --auth login or --auth token.',
    )
  return { mode, token: mode === 'token' ? token : undefined }
}

function createNpmRunner(
  requested: string,
  execute: Executor = run,
  environment: NodeJS.ProcessEnv = process.env,
  packageName = '',
) {
  const auth = resolveAuth(requested, environment)
  const childEnvironment: NodeJS.ProcessEnv = { ...environment }
  for (const key of Object.keys(childEnvironment)) {
    if (/^npm_config_registry$/i.test(key)) delete childEnvironment[key]
  }
  childEnvironment.npm_config_registry = registry
  // A user-level @scope:registry mapping outranks the default registry.
  const scope = /^(@[^/]+)\//.exec(packageName)?.[1]
  const pinned = scope ? [`--${scope}:registry=${registry}`] : []
  let directory: string | undefined
  if (auth.mode !== 'login') {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-npm-auth-'))
    const config = path.join(directory, '.npmrc')
    fs.writeFileSync(
      config,
      auth.mode === 'token'
        ? '//registry.npmjs.org/:_authToken=${MERCATO_NPM_AUTH_TOKEN}\n'
        : '',
      { mode: 0o600 },
    )
    delete childEnvironment.NPM_CONFIG_USERCONFIG
    childEnvironment.npm_config_userconfig = config
    delete childEnvironment.NPM_TOKEN
    delete childEnvironment.NODE_AUTH_TOKEN
    if (auth.token) childEnvironment.MERCATO_NPM_AUTH_TOKEN = auth.token
    else delete childEnvironment.MERCATO_NPM_AUTH_TOKEN
  }
  return {
    mode: auth.mode,
    execute(
      command: string,
      args: string[],
      cwd: string,
      options: RunOptions = {},
    ) {
      return execute(
        command,
        command === 'npm' ? [...args, ...pinned] : args,
        command === 'npm' && directory ? directory : cwd,
        command === 'npm' ? { ...options, env: childEnvironment } : options,
      )
    },
    close() {
      if (directory) fs.rmSync(directory, { recursive: true, force: true })
    },
  }
}

function checkAuthentication(
  cwd: string,
  settings: Settings,
  execute: Executor = run,
): string {
  const npm = createNpmRunner(
    settings.auth || 'auto',
    execute,
    process.env,
    settings.packageName,
  )
  try {
    if (npm.mode === 'trusted') {
      const rawVersion = npm
        .execute('npm', ['--version'], cwd, { capture: true })
        .stdout.trim()
      const match = /^(\d+)\.(\d+)\.(\d+)/.exec(rawVersion)
      if (!match)
        throw new Error(
          '🔑 Cannot determine the npm version. Trusted publishing requires npm 11.5.1 or newer.',
        )
      const [major, minor, patch] = match.slice(1).map(Number)
      if (
        major < 11 ||
        (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))
      )
        throw new Error(
          '🔑 Trusted publishing requires npm 11.5.1 or newer. Upgrade npm in your GitHub Actions job.',
        )
    } else if (
      npm.execute('npm', ['whoami'], cwd, { capture: true, allowFailure: true })
        .status !== 0
    ) {
      throw new Error(
        npm.mode === 'token'
          ? '🔑 npm rejected the token. Check its expiry, package permissions, and npm scope. No files were packaged or published.'
          : '🔑 Sign in to npm first: npm login\nThen retry this command. You can also set NPM_TOKEN or NODE_AUTH_TOKEN and use --auth token. No files were packaged or published.',
      )
    }
    if (
      settings.repository &&
      execute('gh', ['auth', 'status'], cwd, {
        capture: true,
        allowFailure: true,
      }).status !== 0
    )
      throw new Error(
        '🐙 Sign in to GitHub first: gh auth login\nThen retry this command. No files were packaged or published.',
      )
    return npm.mode
  } finally {
    npm.close()
  }
}

export { resolveAuth, createNpmRunner, checkAuthentication }
