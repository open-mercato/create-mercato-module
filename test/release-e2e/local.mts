// Local release checks: publish a fixture module with this tool and install it
// into fresh apps, using only a throwaway npm registry and Git repositories on
// this machine. Nothing is sent to npmjs.com or github.com, and no credentials
// for either are read. See README.md ("Local release checks").
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
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

type Options = { registry: string; results: string; createApp: string }

export function parseLocalOptions(args: string[]): Options {
  const values: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]?.replace(/^--/, '')
    const value = args[index + 1]
    if (!args[index]?.startsWith('--') || !['registry', 'results', 'create-app'].includes(option) || !value || value.startsWith('--') || values[option]) throw new Error(`Invalid option: ${args[index]}. See test/release-e2e/README.md.`)
    values[option] = value
  }
  let registry: URL | undefined
  try { registry = new URL(values.registry ?? process.env.RELEASE_E2E_REGISTRY ?? '') } catch {}
  if (!registry || registry.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(registry.hostname) || registry.username || registry.password || registry.search || registry.hash) throw new Error('--registry must be a throwaway registry on this machine, for example http://127.0.0.1:4874/. It never accepts a remote host.')
  return { registry: registry.href, results: path.resolve(values.results ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-release-local-'))), createApp: values['create-app'] ?? 'create-mercato-app@develop' }
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
