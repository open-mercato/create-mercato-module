import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import net from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fixtureContract } from './fixture.mts'

type Options = {
  packageName: string
  version: string
  repository: string
  ref: string
  createApp: string
  results: string
  lanes: string[]
  reuseApp?: string
}

export function parseOptions(args: string[]): Options {
  const values: Record<string, string> = {}
  const accepted = new Set(['package', 'version', 'repo', 'ref', 'create-app', 'results', 'lanes', 'reuse-app'])
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]?.replace(/^--/, '')
    const value = args[index + 1]
    if (!args[index]?.startsWith('--') || !accepted.has(option) || !value || value.startsWith('--') || values[option]) throw new Error(`Invalid option: ${args[index]}. See test/release-e2e/README.md.`)
    values[option] = value
  }
  const packageName = values.package ?? process.env.RELEASE_E2E_PACKAGE ?? ''
  const version = values.version ?? process.env.RELEASE_E2E_VERSION ?? ''
  const repository = values.repo ?? process.env.RELEASE_E2E_REPO ?? ''
  if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(packageName)) throw new Error('--package must be a scoped npm fixture package name.')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('--version must be an exact published fixture version.')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('--repo must be owner/repository; never put credentials in its URL.')
  const lanes = (values.lanes ?? 'npm,github').split(',')
  if (lanes.some((lane) => !['npm', 'github'].includes(lane)) || new Set(lanes).size !== lanes.length) throw new Error('--lanes must be npm, github, or npm,github.')
  const ref = values.ref ?? version
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) throw new Error('--ref must be a Git tag, branch, or commit SHA.')
  return { packageName, version, repository, ref, createApp: values['create-app'] ?? 'create-mercato-app@develop', results: path.resolve(values.results ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-release-e2e-'))), lanes, reuseApp: values['reuse-app'] ? path.resolve(values['reuse-app']) : undefined }
}

export function redact(text: string, secrets: string[]): string {
  let sanitized = text.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/g, '$1[REDACTED]@').replace(/(?:npm_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED]')
  for (const secret of secrets) if (secret.length >= 6) sanitized = sanitized.split(secret).join('[REDACTED]')
  return sanitized
}

function npmLoginToken(): string | undefined {
  if (process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN) return process.env.NPM_TOKEN ?? process.env.NODE_AUTH_TOKEN
  const filename = process.env.NPM_CONFIG_USERCONFIG ?? path.join(os.homedir(), '.npmrc')
  if (!fs.existsSync(filename)) return undefined
  const token = fs.readFileSync(filename, 'utf8').match(/^\s*\/\/registry\.npmjs\.org\/:_authToken\s*=\s*([^\r\n]+)\s*$/m)?.[1]?.trim()
  return token?.replace(/\$\{([^}]+)\}/g, (_match, name: string) => process.env[name] ?? '')
}

export async function main(args: string[]): Promise<void> {
  const options = parseOptions(args)
  fs.mkdirSync(options.results, { recursive: true })
  const token = npmLoginToken()
  if (options.lanes.includes('npm') && !token) throw new Error('Private npm fixture checks need npm login, NPM_TOKEN, or NODE_AUTH_TOKEN before scaffolding apps.')
  const secrets = [token ?? '', process.env.GH_TOKEN ?? '', process.env.GITHUB_TOKEN ?? '']
  const environment: NodeJS.ProcessEnv = { ...process.env, CI: '1', YARN_ENABLE_PROGRESS_BARS: '0', YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', RELEASE_E2E_NPM_TOKEN: token ?? '' }
  delete environment.npm_config_package
  const npmAuthFile = path.join(options.results, '.npm-auth.npmrc')
  if (token) {
    fs.writeFileSync(npmAuthFile, 'registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${RELEASE_E2E_NPM_TOKEN}\n', { mode: 0o600 })
    environment.NPM_CONFIG_USERCONFIG = npmAuthFile
  }
  const stages: { lane: string; stage: string; status: string; durationMs: number }[] = []
  const node = process.env.RELEASE_E2E_NODE ?? process.execPath
  const yarn = process.env.RELEASE_E2E_YARN ?? 'yarn'
  const npx = process.env.RELEASE_E2E_NPX ?? 'npx'
  const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const toolManifest = JSON.parse(fs.readFileSync(path.join(toolRoot, 'package.json'), 'utf8')) as { bin: Record<string, string> }
  const toolBin = path.join(toolRoot, toolManifest.bin['create-mercato-module'])
  let githubCommit = options.ref
  async function command(lane: string, stage: string, executable: string, commandArgs: string[], cwd: string): Promise<string> {
    const started = Date.now()
    process.stdout.write(`\n🧪 ${lane}: ${stage}\n`)
    const logfile = path.join(options.results, `${lane}-${stage.replace(/[^a-z0-9-]/gi, '-')}.log`)
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, commandArgs, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      const timeout = setTimeout(() => { child.kill('SIGTERM'); }, 15 * 60 * 1000)
      const collect = (chunk: Buffer) => { output += chunk.toString() }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      child.on('error', (error) => { clearTimeout(timeout); reject(error) })
      child.on('close', (code) => {
        clearTimeout(timeout)
        const sanitized = redact(output, secrets)
        fs.writeFileSync(logfile, sanitized)
        stages.push({ lane, stage, status: code === 0 ? 'passed' : 'failed', durationMs: Date.now() - started })
        if (code !== 0) reject(new Error(`${lane}/${stage} exited ${code}. Diagnostics: ${logfile}\n${sanitized.slice(-4000)}`))
        else resolve(output)
      })
    })
  }
  async function nextHttpSmoke(lane: string, app: string, moduleImport: string): Promise<void> {
    const started = Date.now()
    process.stdout.write(`\n🌐 ${lane}: Next.js HTTP module smoke\n`)
    const directory = path.join(app, '.mercato/release-next-smoke')
    fs.mkdirSync(path.join(directory, 'app/api/status'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'release-next-smoke', private: true, type: 'module' }))
    fs.writeFileSync(path.join(directory, 'next.config.mjs'), `export default { transpilePackages: [${JSON.stringify(options.packageName)}], turbopack: { root: ${JSON.stringify(app)} } }\n`)
    fs.writeFileSync(path.join(directory, 'app/layout.jsx'), 'export default function Layout({children}) { return <html><body>{children}</body></html> }\n')
    fs.writeFileSync(path.join(directory, 'app/page.jsx'), `export { default } from ${JSON.stringify(`${moduleImport}/${fixtureContract.page}`)}\n`)
    fs.writeFileSync(path.join(directory, 'app/api/status/route.js'), `export { GET } from ${JSON.stringify(`${moduleImport}/${fixtureContract.api}`)}\n`)
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') { server.close(); reject(new Error('Cannot allocate Next smoke port')); return }
        server.close(() => resolve(address.port))
      })
    })
    const nextBin = createRequire(path.join(app, 'package.json')).resolve('next/dist/bin/next')
    const child = spawn(node, [nextBin, 'dev', directory, '--hostname', '127.0.0.1', '--port', String(port)], { cwd: app, env: { ...environment, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let exited = false
    let spawnError: Error | undefined
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', (error) => { spawnError = error; exited = true })
    child.on('close', () => { exited = true })
    try {
      let page: Response | undefined
      while (Date.now() - started < 120000) {
        if (exited) throw spawnError ?? new Error('Next smoke server exited before responding')
        try { page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(15000) }); break } catch { await new Promise((resolve) => setTimeout(resolve, 500)) }
      }
      assert.ok(page, 'Next smoke server must start within two minutes')
      assert.equal(page.status, 200, 'Next must render the installed module page')
      assert.ok((await page.text()).includes(`<h1>${fixtureContract.marker}</h1>`), 'HTTP output must contain the installed React page')
      const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(30000) })
      assert.equal(response.status, 200, 'Next must execute installed module API')
      assert.deepEqual(await response.json(), { marker: fixtureContract.marker, field: 'status', entity: 'release_checks:release_check' })
      stages.push({ lane, stage: 'next-http-smoke', status: 'passed', durationMs: Date.now() - started })
    } catch (error) {
      stages.push({ lane, stage: 'next-http-smoke', status: 'failed', durationMs: Date.now() - started })
      throw error
    } finally {
      if (!exited) {
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
        child.kill('SIGTERM')
        const force = setTimeout(() => child.kill('SIGKILL'), 5000)
        await closed
        clearTimeout(force)
      }
      fs.writeFileSync(path.join(options.results, `${lane}-next-http-smoke.log`), redact(output, secrets))
    }
  }
  try {
    await command('preflight', 'node-version', node, ['--version'], toolRoot)
    await command('preflight', 'yarn-version', yarn, ['--version'], toolRoot)
    if (options.lanes.includes('npm') && token) {
      await command('preflight', 'npm-auth', 'npm', ['whoami'], toolRoot)
      const registryVersion = await command('preflight', 'npm-fixture-available', 'npm', ['view', `${options.packageName}@${options.version}`, 'version', '--json'], toolRoot)
      assert.equal(JSON.parse(registryVersion.trim()), options.version, 'Wait until the registry exposes the exact fixture version before running release checks')
    }
    if (options.lanes.includes('github')) {
      await command('preflight', 'github-auth', 'gh', ['auth', 'status'], toolRoot)
      githubCommit = (await command('preflight', 'github-fixture-available', 'gh', ['api', `repos/${options.repository}/commits/${encodeURIComponent(options.ref)}`, '--jq', '.sha'], toolRoot)).trim()
      assert.match(githubCommit, /^[0-9a-f]{40}$/, 'GitHub fixture ref must resolve to one immutable full commit SHA')
    }
    for (const lane of options.lanes) {
      const app = options.reuseApp && options.lanes.length === 1 ? options.reuseApp : path.join(options.results, `${lane}-app`)
      if (app !== options.reuseApp) {
        if (fs.existsSync(app)) throw new Error(`Refusing to overwrite existing app: ${app}`)
        await command(lane, 'scaffold', npx, ['--yes', '--package', options.createApp, '--', 'create-mercato-app', app, '--preset', 'empty', '--agents', 'none', '--no-init-git'], options.results)
      }
      const yarnConfig = path.join(app, '.yarnrc.yml')
      const originalConfig = fs.readFileSync(yarnConfig, 'utf8')
      try {
        await command(lane, 'approve-fixture-age', yarn, ['config', 'set', 'npmPreapprovedPackages', '--json', JSON.stringify(['@open-mercato/*', options.packageName])], app)
        if (token) {
          await command(lane, 'configure-npm-token', yarn, ['config', 'set', 'npmAuthToken', '${RELEASE_E2E_NPM_TOKEN}'], app)
          await command(lane, 'configure-npm-auth', yarn, ['config', 'set', 'npmAlwaysAuth', 'true'], app)
        }
        await command(lane, 'install-clean-app', yarn, ['install'], app)
        if (lane === 'github') {
          await command(lane, 'git-init-app', 'git', ['init', '--initial-branch=main'], app)
          await command(lane, 'git-config-name', 'git', ['config', 'user.name', 'Release harness'], app)
          await command(lane, 'git-config-email', 'git', ['config', 'user.email', 'release-harness@example.invalid'], app)
          await command(lane, 'git-add-app', 'git', ['add', 'package.json', 'src/modules.ts', '.gitignore'], app)
          await command(lane, 'git-commit-app', 'git', ['commit', '-m', 'Fixture app before module development'], app)
        }
        const localId = 'local_release_checks'
        if (fs.existsSync(path.join(app, 'src/modules', localId))) throw new Error(`App already has harness local module ${localId}. Use a clean app.`)
        await command(lane, 'init-new-local-module', node, [toolBin, 'init', localId], app)
        await command(lane, 'pack-existing-local-module', node, [toolBin, 'publish', localId, '--package', '@fixture/local-release-checks', '--version', '0.0.1', '--dry-run'], app)
        assert.ok(fs.existsSync(path.join(app, 'src/modules', localId, 'index.ts')))
        const registrationsBeforeInstall = fs.readFileSync(path.join(app, 'src/modules.ts'), 'utf8')
        assert.match(registrationsBeforeInstall, /local_release_checks/)
        if (lane === 'npm') await command(lane, 'install-module-from-npm', yarn, ['mercato', 'module', 'add', `${options.packageName}@${options.version}`, '--allow-third-party'], app)
        else {
          await command(lane, 'install-module-from-github', yarn, ['add', `${options.packageName}@github:${options.repository}#${githubCommit}`], app)
          await command(lane, 'enable-github-module', yarn, ['mercato', 'module', 'enable', options.packageName, '--allow-third-party'], app)
        }
        await command(lane, 'regenerate-app', yarn, ['generate'], app)
        const appRequire = createRequire(path.join(app, 'package.json'))
        const packageManifest = appRequire(`${options.packageName}/package.json`) as { version: string }
        assert.equal(packageManifest.version, options.version)
        const registration = fs.readFileSync(path.join(app, 'src/modules.ts'), 'utf8')
        assert.ok(registration.includes(options.packageName), 'Module registration must use the installed package')
        const moduleImport = `${options.packageName}/modules/${fixtureContract.moduleId}`
        const generatedDirectory = path.join(app, '.mercato/generated')
        const registries = fs.readdirSync(generatedDirectory).filter((filename) => filename.endsWith('.ts')).map((filename) => fs.readFileSync(path.join(generatedDirectory, filename), 'utf8')).join('\n')
        assert.ok(registries.includes(`${moduleImport}/${fixtureContract.page}`), 'Page must appear in generated registries')
        assert.ok(registries.includes(`${moduleImport}/${fixtureContract.api}`), 'API must appear in generated registries')
        assert.ok(registries.includes(`${moduleImport}/${fixtureContract.entity}`), 'Entity must appear in generated registries')
        const runtimeProbe = `import assert from 'node:assert/strict'; import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url'; const require = createRequire(import.meta.url); await import('reflect-metadata'); const base = ${JSON.stringify(moduleImport)}; const page = await import(pathToFileURL(require.resolve(base + '/${fixtureContract.page}')).href); const react = require('react'); const renderer = require('react-dom/server'); assert.equal(renderer.renderToStaticMarkup(react.createElement(page.default)), '<h1>${fixtureContract.marker}</h1>'); const api = await import(pathToFileURL(require.resolve(base + '/${fixtureContract.api}')).href); assert.deepEqual(await (await api.GET()).json(), { marker: '${fixtureContract.marker}', field: 'status', entity: 'release_checks:release_check' }); const entities = await import(pathToFileURL(require.resolve(base + '/${fixtureContract.entity}')).href); assert.equal(new entities.ReleaseCheck().status, 'draft'); assert.equal(Reflect.getMetadata('design:type', entities.ReleaseCheck.prototype, 'updatedAt'), Date); assert.equal(require(base + '/i18n/en.json')['${fixtureContract.translationKey}'], '${fixtureContract.marker}'); console.log('Runtime page, API, entity decorators and translations passed');\n`
        const probePath = path.join(app, 'release-runtime-probe.mjs')
        fs.writeFileSync(probePath, runtimeProbe)
        await command(lane, 'runtime-imports', node, [probePath], app)
        await nextHttpSmoke(lane, app, moduleImport)
        const installedRoot = path.dirname(appRequire.resolve(`${options.packageName}/package.json`))
        for (const prefix of ['src', 'dist']) {
          assert.equal(fs.readFileSync(path.join(installedRoot, prefix, 'modules', fixtureContract.moduleId, fixtureContract.asset), 'utf8').trim(), fixtureContract.marker)
          assert.ok(fs.existsSync(path.join(installedRoot, prefix, 'modules', fixtureContract.moduleId, 'migrations/.snapshot-open-mercato.json')))
        }
        assert.ok(!fs.existsSync(path.join(app, 'src/modules', fixtureContract.moduleId)), 'Consumer must load packaged source, not a local copy')
        if (lane === 'npm') assert.ok(!fs.existsSync(path.join(app, '.git')), 'No-Git app must stay without a Git repository')
        else {
          const origin = await command(lane, 'check-app-origin', 'git', ['remote'], app)
          assert.equal(origin.trim(), '', 'Module install must not add an application Git remote')
        }
        stages.push({ lane, stage: 'assert-discovery-and-runtime', status: 'passed', durationMs: 0 })
      } finally {
        fs.writeFileSync(yarnConfig, originalConfig)
      }
    }
    process.stdout.write(`\n✅ All requested release lanes passed. Results retained at ${options.results}\n`)
  } finally {
    fs.rmSync(npmAuthFile, { force: true })
    fs.writeFileSync(path.join(options.results, 'results.json'), JSON.stringify({ createdAt: new Date().toISOString(), nodeVersion: process.version, options, stages }, null, 2) + '\n')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`\n❌ ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
}
