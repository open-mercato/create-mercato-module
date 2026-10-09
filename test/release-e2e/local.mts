// Local release checks: publish a fixture module with this tool and install it
// into fresh apps, using only a throwaway npm registry and Git repositories on
// this machine. Nothing is sent to npmjs.com or github.com, and no credentials
// for either are read. See README.md ("Local release checks").
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { writeFixture, fixtureContract } from './fixture.mts'
import { main as runLanes, redact } from './run.mts'

const packageName = '@mercato-e2e/release-checks'
const repository = 'mercato-e2e/release-checks'
const versions = ['0.0.1', '0.0.2']

type Options = { registry: string; results: string; createApp: string; databaseUrl?: string }

export function parseLocalOptions(args: string[]): Options {
  const values: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]?.replace(/^--/, '')
    const value = args[index + 1]
    if (!args[index]?.startsWith('--') || !['registry', 'results', 'create-app', 'database-url'].includes(option) || !value || value.startsWith('--') || values[option]) throw new Error(`Invalid option: ${args[index]}. See test/release-e2e/README.md.`)
    values[option] = value
  }
  let registry: URL | undefined
  try { registry = new URL(values.registry ?? process.env.RELEASE_E2E_REGISTRY ?? '') } catch {}
  if (!registry || registry.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(registry.hostname) || registry.username || registry.password || registry.search || registry.hash) throw new Error('--registry must be a throwaway registry on this machine, for example http://127.0.0.1:4874/. It never accepts a remote host.')
  let database: URL | undefined
  const databaseValue = values['database-url'] ?? process.env.RELEASE_E2E_DATABASE_URL
  if (databaseValue) {
    try { database = new URL(databaseValue) } catch {}
    if (!database || !['postgres:', 'postgresql:'].includes(database.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)) throw new Error('--database-url must be a throwaway Postgres on this machine, for example postgres://postgres:postgres@127.0.0.1:54329/open-mercato. The checks initialize it from scratch.')
  }
  return { databaseUrl: database?.href, registry: registry.href, results: path.resolve(values.results ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-release-local-'))), createApp: values['create-app'] ?? 'create-mercato-app@develop' }
}

// Serves the bare repositories over loopback HTTP so Yarn can install from them.
function serveRepositories(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const file = path.join(root, decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname))
    if (request.method !== 'GET' || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return }
    response.writeHead(200)
    fs.createReadStream(file).pipe(response)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { reject(new Error('Cannot start the local Git server')); return }
      resolve({ url: `http://127.0.0.1:${address.port}/`, close: () => new Promise((done) => server.close(() => done())) })
    })
  })
}

export async function main(args: string[]): Promise<void> {
  const options = parseLocalOptions(args)
  fs.mkdirSync(options.results, { recursive: true })
  const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const toolBin = path.join(toolRoot, (JSON.parse(fs.readFileSync(path.join(toolRoot, 'package.json'), 'utf8')) as { bin: Record<string, string> }).bin['create-mercato-module'])
  const yarn = process.env.RELEASE_E2E_YARN ?? 'yarn'
  const npx = process.env.RELEASE_E2E_NPX ?? 'npx'

  assert.ok((await fetch(new URL('-/ping', options.registry), { signal: AbortSignal.timeout(5000) })).ok, `No registry answers at ${options.registry}. Start the throwaway registry first; see test/release-e2e/README.md.`)
  const user = `release-checks-${randomBytes(4).toString('hex')}`
  const created = await fetch(new URL(`-/user/org.couchdb.user:${user}`, options.registry), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: user, password: randomBytes(18).toString('hex') }), signal: AbortSignal.timeout(10000) })
  const token = ((await created.json()) as { token?: string }).token
  assert.ok(created.ok && token, 'The local registry did not issue a token for the release-check user')

  const githubRoot = path.join(options.results, 'github')
  const binaries = path.join(options.results, 'bin')
  fs.mkdirSync(githubRoot, { recursive: true })
  fs.mkdirSync(binaries, { recursive: true })
  fs.writeFileSync(path.join(binaries, 'gh'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(toolRoot, 'test/release-e2e/gh-shim.mjs'))} "$@"\n`, { mode: 0o755 })

  // The publishing tool sees the stand-in gh first and no real npm or GitHub credential.
  const environment: NodeJS.ProcessEnv = { ...process.env, CI: '1', YARN_ENABLE_PROGRESS_BARS: '0', YARN_ENABLE_IMMUTABLE_INSTALLS: 'false', PATH: `${binaries}${path.delimiter}${process.env.PATH ?? ''}`, RELEASE_E2E_GITHUB_ROOT: githubRoot, MERCATO_NPM_REGISTRY: options.registry, NPM_TOKEN: token }
  for (const name of ['NODE_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'npm_config_package']) delete environment[name]
  const stages: { stage: string; status: string; durationMs: number }[] = []
  async function command(stage: string, executable: string, commandArgs: string[], cwd: string): Promise<string> {
    const started = Date.now()
    process.stdout.write(`\n🧪 local: ${stage}\n`)
    const logfile = path.join(options.results, `local-${stage.replace(/[^a-z0-9-]/gi, '-')}.log`)
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, commandArgs, { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      const timeout = setTimeout(() => { child.kill('SIGTERM') }, 15 * 60 * 1000)
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.on('error', (error) => { clearTimeout(timeout); reject(error) })
      child.on('close', (code) => {
        clearTimeout(timeout)
        const sanitized = redact(output, [token])
        fs.writeFileSync(logfile, sanitized)
        stages.push({ stage, status: code === 0 ? 'passed' : 'failed', durationMs: Date.now() - started })
        if (code !== 0) reject(new Error(`local/${stage} exited ${code}. Diagnostics: ${logfile}\n${sanitized.slice(-4000)}`))
        else resolve(output)
      })
    })
  }

  // Starts the consumer app itself, with its database, and uses the installed module the way a
  // signed-in user would: the API must refuse anonymous calls and the backend page must render.
  async function fullAppCheck(app: string, databaseUrl: string): Promise<void> {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => (address && typeof address !== 'string' ? resolve(address.port) : reject(new Error('Cannot allocate an app port')))) })
    })
    const baseUrl = `http://127.0.0.1:${port}`
    const saved = { ...environment }
    Object.assign(environment, { DATABASE_URL: databaseUrl, PORT: String(port), APP_URL: baseUrl, NEXT_PUBLIC_APP_URL: baseUrl, NEXT_TELEMETRY_DISABLED: '1', OM_INIT_ADMIN_PASSWORD: 'secret', OM_INIT_EMPLOYEE_PASSWORD: 'secret', AUTO_SPAWN_WORKERS: 'false', AUTO_SPAWN_SCHEDULER: 'false' })
    for (const name of ['NPM_TOKEN', 'MERCATO_NPM_REGISTRY']) delete environment[name]
    const started = Date.now()
    let output = ''
    let child: ReturnType<typeof spawn> | undefined
    try {
      await command('full-app-initialize', yarn, ['initialize'], app)
      process.stdout.write('\n🌐 local: full app with database and sign-in\n')
      child = spawn(yarn, ['mercato', 'server', 'dev'], { cwd: app, env: environment, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      let exited = false
      child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.on('close', () => { exited = true })
      let ready = false
      while (!ready && Date.now() - started < 10 * 60 * 1000) {
        if (exited) throw new Error('The app stopped before it answered requests')
        try { ready = (await fetch(`${baseUrl}/login`, { signal: AbortSignal.timeout(60000) })).status === 200 } catch {}
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 2000))
      }
      assert.ok(ready, 'The app must serve its login page within ten minutes')
      const route = `${baseUrl}/api/${fixtureContract.moduleId}/status`
      assert.equal((await fetch(route, { signal: AbortSignal.timeout(180000) })).status, 401, 'The module API must refuse anonymous requests')
      const login = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'admin@acme.com', password: 'secret' }).toString(), signal: AbortSignal.timeout(180000) })
      assert.equal(login.status, 200, 'The seeded admin must be able to sign in')
      const session = (await login.json()) as { token?: string }
      const cookies = new Map(login.headers.getSetCookie().map((cookie) => cookie.split(';')[0].split(/=(.*)/s).slice(0, 2) as [string, string]))
      assert.ok(session.token && cookies.size, 'Sign-in must return a token and a session cookie')
      const api = await fetch(route, { headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(180000) })
      assert.equal(api.status, 200, 'The module API must answer a signed-in user')
      assert.deepEqual(await api.json(), { marker: fixtureContract.marker, field: 'status', entity: 'release_checks:release_check' })
      let page = new URL(`/backend/${fixtureContract.moduleId}`, baseUrl)
      let html = ''
      for (let redirects = 0; ; redirects += 1) {
        const response = await fetch(page, { redirect: 'manual', headers: { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') }, signal: AbortSignal.timeout(240000) })
        for (const cookie of response.headers.getSetCookie()) { const [name, value] = cookie.split(';')[0].split(/=(.*)/s); cookies.set(name, value) }
        const location = response.headers.get('location')
        if (response.status >= 300 && response.status < 400 && location && redirects < 5) { page = new URL(location, page); assert.equal(page.origin, baseUrl, 'The app must not redirect off this machine'); continue }
        assert.equal(response.status, 200, `The module backend page must render for a signed-in user (${page.pathname})`)
        html = await response.text()
        break
      }
      assert.equal(page.pathname, `/backend/${fixtureContract.moduleId}`, 'A signed-in user must stay on the module page')
      assert.ok(html.includes(`<h1>${fixtureContract.marker}</h1>`), 'The backend page must contain the module content')
      stages.push({ stage: 'full-app-signed-in-module', status: 'passed', durationMs: Date.now() - started })
    } catch (error) {
      stages.push({ stage: 'full-app-signed-in-module', status: 'failed', durationMs: Date.now() - started })
      throw error
    } finally {
      if (child?.pid && child.exitCode === null) {
        const closed = new Promise<void>((resolve) => child!.once('close', () => resolve()))
        try { process.kill(-child.pid, 'SIGTERM') } catch {}
        const force = setTimeout(() => { try { process.kill(-child!.pid!, 'SIGKILL') } catch {} }, 10000)
        await closed
        clearTimeout(force)
      }
      fs.writeFileSync(path.join(options.results, 'local-full-app-server.log'), redact(output, [token]))
      for (const name of Object.keys(environment)) delete environment[name]
      Object.assign(environment, saved)
    }
  }

  let server: Awaited<ReturnType<typeof serveRepositories>> | undefined
  try {
    const sourceApp = path.join(options.results, 'source-app')
    if (fs.existsSync(sourceApp)) throw new Error(`Refusing to overwrite existing app: ${sourceApp}`)
    await command('scaffold-source-app', npx, ['--yes', '--package', options.createApp, '--', 'create-mercato-app', sourceApp, '--preset', 'empty', '--agents', 'none', '--no-init-git'], options.results)
    await command('install-source-app', yarn, ['install'], sourceApp)
    // The published module starts as a real `init` scaffold and gains a page, API, entity and assets.
    await command('init-module', process.execPath, [toolBin, 'init', fixtureContract.moduleId], sourceApp)
    assert.match(fs.readFileSync(path.join(sourceApp, 'src/modules.ts'), 'utf8'), new RegExp(`id: '${fixtureContract.moduleId}', from: '@app'`), 'init must register the new module')
    writeFixture(sourceApp, { extend: true })
    await command('generate-source-app', yarn, ['generate'], sourceApp)

    const bare = path.join(githubRoot, `${repository}.git`)
    for (const [index, version] of versions.entries()) {
      const output = await command(`publish-${version}`, process.execPath, [toolBin, 'publish', fixtureContract.moduleId, '--package', packageName, '--version', version, '--repo', repository, '--access', 'restricted', '--auth', 'token', '--yes'], sourceApp)
      assert.match(output, /Using the local test registry/, 'Publication must target the local registry')
      assert.match(output, index === 0 ? /new private repository will be created/ : /existing private repository/, 'The summary must state what happens to the repository')
      assert.doesNotMatch(output, /⚠️/, 'A repository released only by this tool needs no extra approval')
      const published = (await (await fetch(new URL(packageName.replace('/', '%2f'), options.registry))).json()) as { versions?: Record<string, unknown> }
      assert.ok(published.versions?.[version], `The local registry must hold ${packageName}@${version}`)
      assert.match(await command(`release-commit-${version}`, 'git', ['--git-dir', bare, 'log', '-1', '--format=%B', 'main'], options.results), new RegExp(`^Release ${packageName}@${version.replaceAll('.', '\\.')}\\n\\nMercato-Source: app`), 'The repository must receive the release commit')
    }
    assert.equal((await command('release-history', 'git', ['--git-dir', bare, 'rev-list', '--count', 'main'], options.results)).trim(), String(versions.length))

    // Without approval, and with a repository change the app did not release, nothing may be published.
    const refused = await command('refuse-without-approval', process.execPath, ['-e', `const r=require('node:child_process').spawnSync(process.execPath,[${JSON.stringify(toolBin)},'publish',${JSON.stringify(fixtureContract.moduleId)},'--package',${JSON.stringify(packageName)},'--version','0.0.3','--repo',${JSON.stringify(repository)},'--access','restricted','--auth','token'],{encoding:'utf8'});console.log(r.stdout+r.stderr);process.exit(r.status===1?0:1)`], sourceApp)
    assert.match(refused, /Nothing was published/)
    assert.equal((await (await fetch(new URL(packageName.replace('/', '%2f'), options.registry))).json() as { versions: Record<string, unknown> }).versions['0.0.3'], undefined, 'An unapproved run must not publish')

    const version = versions.at(-1)!
    await command('prepare-git-server', 'git', ['--git-dir', bare, 'update-server-info'], options.results)
    server = await serveRepositories(githubRoot)
    fs.writeFileSync(path.join(options.results, 'local-results.json'), JSON.stringify({ createdAt: new Date().toISOString(), registry: options.registry, packageName, version, stages }, null, 2) + '\n')

    process.env.RELEASE_E2E_LOCAL_TOKEN = token
    const shared = ['--package', packageName, '--version', version, '--repo', repository, '--ref', 'main', '--create-app', options.createApp, '--registry', options.registry, '--git-url', `${server.url}${repository}.git`]
    // Each lane installs into its own fresh app, never the one that published the module.
    await runLanes([...shared, '--lanes', 'npm,github', '--results', path.join(options.results, 'consumers')])
    if (options.databaseUrl) await fullAppCheck(path.join(options.results, 'consumers/npm-app'), options.databaseUrl)
    else process.stdout.write('\nℹ️ Full-app check not run: pass --database-url to start the app with a database and sign in.\n')
    process.stdout.write(`\n✅ Local release checks passed without contacting npmjs.com or github.com for the fixture. Results: ${options.results}\n`)
  } finally {
    delete process.env.RELEASE_E2E_LOCAL_TOKEN
    await server?.close()
    fs.writeFileSync(path.join(options.results, 'local-results.json'), JSON.stringify({ createdAt: new Date().toISOString(), registry: options.registry, packageName, stages }, null, 2) + '\n')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`\n❌ ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
}
