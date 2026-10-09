import type { App, PackageManifest, RunOptions } from './types.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

function readJson<T = PackageManifest>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function within(root: string, file: string) {
  const relative = path.relative(root, file)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

function validateId(id: string) {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(id || '')) {
    throw new Error(
      'Use a module name in snake_case, for example customer_visits.',
    )
  }
  return id
}

function findApp(start = process.cwd()): App {
  let directory = fs.realpathSync(start)
  const startingDirectory = directory
  while (true) {
    const manifest = path.join(directory, 'package.json')
    const modulesFile = path.join(directory, 'src/modules.ts')
    if (
      fs.existsSync(manifest) &&
      fs.statSync(manifest).isFile() &&
      fs.existsSync(modulesFile) &&
      fs.statSync(modulesFile).isFile()
    ) {
      const app = readJson(manifest)
      if (app.dependencies?.['@open-mercato/core']) {
        let installed = path.join(
          directory,
          'node_modules/@open-mercato/core/package.json',
        )
        if (!fs.existsSync(installed)) {
          try {
            const loader = createRequire(manifest)
            installed = loader.resolve('@open-mercato/core/package.json')
          } catch {
            try {
              let packageDirectory = path.dirname(
                createRequire(manifest).resolve('@open-mercato/core'),
              )
              while (
                !fs.existsSync(path.join(packageDirectory, 'package.json'))
              ) {
                const parent = path.dirname(packageDirectory)
                if (parent === packageDirectory) break
                packageDirectory = parent
              }
              installed = path.join(packageDirectory, 'package.json')
            } catch {}
          }
        }
        if (
          !fs.existsSync(installed) ||
          readJson(installed).name !== '@open-mercato/core'
        ) {
          throw new Error(
            `Open Mercato app found, but its dependencies are not installed.\n\n  App: ${directory}\n\nRun yarn install in the app, then retry this command.\nThe tool needs the installed @open-mercato/core package before it can create or publish modules.`,
          )
        }
        return { directory, manifest: app }
      }
    }
    const parent = path.dirname(directory)
    if (parent === directory)
      throw new Error(
        `No Open Mercato app found here.\n\n  Current directory: ${startingDirectory}\n\nRun this tool inside an existing create-mercato-app application (or one of its subdirectories):\n\n  cd /path/to/your-mercato-app\n  npx create-mercato-module init visits\n\nThe app must have src/modules.ts and @open-mercato/core in package.json.\nNeed an app first? Run npx create-mercato-app my-app, install its dependencies, then cd my-app.\n\nNo files were changed.`,
      )
    directory = parent
  }
}

const captureTimeout = 120_000
const captureBuffer = 64 * 1024 * 1024

function run(
  command: string,
  args: string[],
  cwd: string,
  options: RunOptions = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...(options.capture
      ? { timeout: captureTimeout, maxBuffer: captureBuffer }
      : {}),
    ...options,
  })
  if (result.error) {
    if ('code' in result.error && result.error.code === 'ETIMEDOUT')
      throw new Error(
        `${command} ${args[0] ?? ''} did not finish in time. Check network access and retry.`,
      )
    throw new Error(
      `Cannot run ${command}: ${safeCommandOutput(result.error.message, options.env)}`,
    )
  }
  if (result.status !== 0 && !options.allowFailure) {
    const details = options.capture
      ? safeCommandOutput(
          [result.stderr, result.stdout]
            .filter((value) => typeof value === 'string' && value.trim())
            .join('\n'),
          options.env,
        )
      : ''
    throw new Error(
      `${command} failed (exit ${result.status ?? 'signal'}).${details ? `\n\n${details}\n\nFix this error and retry.` : ' Fix the reported error and retry.'}`,
    )
  }
  return result
}

function safeCommandOutput(
  output: string,
  environment?: NodeJS.ProcessEnv,
): string {
  let sanitized = output
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
      '$1[REDACTED]@',
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(
      /\b(?:npm_[A-Za-z0-9_]{15,}|github_pat_[A-Za-z0-9_]{15,}|gh[pousr]_[A-Za-z0-9_]{15,})/g,
      '[REDACTED]',
    )
    .replace(
      /((?:["']?)(?:[a-z0-9_-]*(?:token|secret|password|api[_-]?key)|authorization)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,&;]+)/gi,
      '$1[REDACTED]',
    )
  for (const source of [process.env, environment ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (
        value &&
        value.length >= 8 &&
        /token|secret|password|passwd|api_?key|authorization/i.test(key)
      )
        sanitized = sanitized.split(value).join('[REDACTED]')
    }
  }
  sanitized = sanitized.trim()
  return sanitized.length > 3000 ? `…\n${sanitized.slice(-3000)}` : sanitized
}

function moduleDirectory(app: App, id: string) {
  validateId(id)
  const root = path.join(app.directory, 'src/modules')
  const directory = path.join(root, id)
  if (!fs.existsSync(path.join(directory, 'index.ts')))
    throw new Error(`No local module at src/modules/${id}/index.ts.`)
  if (
    !within(root, fs.realpathSync(directory)) ||
    fs.lstatSync(directory).isSymbolicLink()
  ) {
    throw new Error('The module must be a real directory inside src/modules.')
  }
  return directory
}

export {
  readJson,
  writeJson,
  within,
  validateId,
  findApp,
  run,
  moduleDirectory,
}
