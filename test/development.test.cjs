const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { spawn } = require('node:child_process')
const net = require('node:net')
const { linkDevelopment, linkedModuleDirectory } = require('../dist/development.js')
const { run, writeJson } = require('../dist/common.js')

const settings = { repository: 'fixture/mercato-visits', packageName: '@fixture/visits' }

function fixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-source-link-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'app')
  const remote = path.join(root, 'remote')
  fs.mkdirSync(path.join(directory, 'src/modules/visits'), { recursive: true })
  fs.mkdirSync(path.join(directory, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'src/modules/visits/index.ts'), "export const metadata = { name: 'visits', title: 'Original local visits' }\n")
  fs.writeFileSync(path.join(directory, 'src/modules.ts'), "export const enabledModules = [{ id: 'visits', from: '@app' }]\n")
  writeJson(path.join(directory, 'package.json'), { name: 'fixture-app', private: true })
  fs.writeFileSync(path.join(directory, '.gitignore'), '.mercato/\nnode_modules/\n')
  writeJson(path.join(remote, 'package.json'), { name: options.packageName || settings.packageName, mercatoModule: { id: 'visits', formatVersion: 1 } })
  fs.mkdirSync(path.join(remote, 'src/modules/visits/backend/visits'), { recursive: true })
  fs.writeFileSync(path.join(remote, 'src/modules/visits/index.ts'), "export const metadata = { name: 'visits', title: 'Repository visits', version: '0.1.0' }\n")
  fs.writeFileSync(path.join(remote, 'src/modules/visits/backend/visits/page.tsx'), 'export default function Visits() { return <h1>Repository visits</h1> }\n')
  fs.writeFileSync(path.join(remote, '.gitignore'), 'node_modules/\n')
  run('git', ['init', '-q', '--initial-branch=main'], remote, { capture: true })
  run('git', ['add', '.'], remote, { capture: true })
  run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Initial module'], remote, { capture: true })
  const calls = []
  const execute = (command, args, cwd, runOptions = {}) => {
    calls.push({ command, args, cwd })
    if (command === 'gh' && args[0] === 'auth') return { status: options.loggedOut ? 1 : 0, stdout: '', stderr: '' }
    if (command === 'gh' && args[0] === 'api') {
      const missing = { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }
      if (options.github === 'missing') return missing
      if (options.github === 'offline') return { status: 1, stdout: '', stderr: 'connection refused' }
      if (!args[1].endsWith('/contents/package.json')) return { status: 0, stdout: '{}', stderr: '' }
      if (options.github === 'changes-before-clone') return { status: 0, stdout: JSON.stringify({ name: settings.packageName, mercatoModule: { id: 'visits', formatVersion: 1 } }), stderr: '' }
      return options.github === 'empty' ? missing : { status: 0, stdout: fs.readFileSync(path.join(remote, 'package.json'), 'utf8'), stderr: '' }
    }
    if (command === 'gh' && args[0] === 'repo' && args[1] === 'clone') return run('git', ['clone', remote, args[3]], cwd, { capture: true })
    return run(command, args, cwd, { ...runOptions, capture: true })
  }
  return { root, directory, remote, execute, calls }
}

test('development keeps @app, backs up local source, shares dependencies, and leaves application Git origin and HEAD intact', (context) => {
  const app = fixture(context)
  run('git', ['init', '-q', '--initial-branch=main'], app.directory, { capture: true })
  run('git', ['remote', 'add', 'origin', 'https://example.com/whole-app.git'], app.directory, { capture: true })
  run('git', ['add', '.'], app.directory, { capture: true })
  run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Whole application'], app.directory, { capture: true })
  const head = run('git', ['rev-parse', 'HEAD'], app.directory, { capture: true }).stdout
  const registration = fs.readFileSync(path.join(app.directory, 'src/modules.ts'), 'utf8')
  const link = linkDevelopment(app, 'visits', settings, app.execute)
  const source = linkedModuleDirectory(app, 'visits', link)
  assert.equal(source, path.join(app.directory, '.mercato/module-repos/visits/src/modules/visits'))
  assert.equal(fs.lstatSync(path.join(app.directory, 'src/modules/visits')).isSymbolicLink(), true)
  assert.equal(path.isAbsolute(fs.readlinkSync(path.join(app.directory, 'src/modules/visits'))), false)
  assert.match(fs.readFileSync(path.join(app.directory, link.backupPath, 'index.ts'), 'utf8'), /Original local visits/)
  assert.match(fs.readFileSync(path.join(app.directory, 'src/modules/visits/index.ts'), 'utf8'), /Repository visits/)
  fs.writeFileSync(path.join(app.directory, 'src/modules/visits/new-source.ts'), "export const label = 'Changed inside original app'\n")
  assert.match(fs.readFileSync(path.join(source, 'new-source.ts'), 'utf8'), /Changed inside original app/)
  assert.match(run('git', ['status', '--short'], path.join(app.directory, link.checkoutPath), { capture: true }).stdout, /new-source.ts/)
  assert.equal(fs.realpathSync(path.join(app.directory, link.checkoutPath, 'node_modules')), fs.realpathSync(path.join(app.directory, 'node_modules')))
  assert.equal(fs.readFileSync(path.join(app.directory, 'src/modules.ts'), 'utf8'), registration)
  assert.equal(run('git', ['rev-parse', 'HEAD'], app.directory, { capture: true }).stdout, head)
  assert.equal(run('git', ['remote', 'get-url', 'origin'], app.directory, { capture: true }).stdout.trim(), 'https://example.com/whole-app.git')
  assert.doesNotMatch(run('git', ['status', '--short'], path.join(app.directory, link.checkoutPath), { capture: true }).stdout, /node_modules/, 'the shared dependency symlink must never be committed')
  assert.deepEqual(linkDevelopment(app, 'visits', { ...settings, linkedDevelopment: link }, app.execute), link)
  assert.equal(app.calls.filter((call) => call.command === 'gh' && call.args[0] === 'repo').length, 1)
})

test('development restores the local module when its link cannot be saved', (context) => {
  const app = fixture(context)
  assert.throws(() => linkDevelopment(app, 'visits', settings, app.execute, () => { throw new Error('metadata is read-only') }), /metadata is read-only/)
  assert.equal(fs.lstatSync(path.join(app.directory, 'src/modules/visits')).isSymbolicLink(), false)
  assert.match(fs.readFileSync(path.join(app.directory, 'src/modules/visits/index.ts'), 'utf8'), /Original local visits/)
  assert.equal(fs.existsSync(path.join(app.directory, '.mercato/module-repos/visits')), false)
  assert.ok(linkDevelopment(app, 'visits', settings, app.execute), 'a failed link must leave the app ready for a retry')
})

test('link explains how to publish first when the module is not in its GitHub repository', (context) => {
  for (const [github, expected] of [['missing', /does not exist on GitHub yet[\s\S]*publish visits --package @fixture\/visits --repo fixture\/mercato-visits/], ['empty', /has not been published to it yet[\s\S]*publish visits --package/], ['offline', /Cannot inspect the GitHub repository/]]) {
    const app = fixture(context, { github })
    assert.throws(() => linkDevelopment(app, 'visits', settings, app.execute), expected, github)
    assert.equal(fs.existsSync(path.join(app.directory, '.mercato')), false, 'nothing may be cloned or created')
    assert.equal(fs.lstatSync(path.join(app.directory, 'src/modules/visits')).isSymbolicLink(), false)
    assert.equal(app.calls.some((call) => call.args[0] === 'repo'), false)
  }
  const other = fixture(context, { packageName: '@fixture/other' })
  assert.throws(() => linkDevelopment(other, 'visits', settings, other.execute), /holds @fixture\/other, not @fixture\/visits \/ visits[\s\S]*--repo/)
  assert.equal(fs.existsSync(path.join(other.directory, '.mercato')), false)
})

test('development also links apps without Git and authenticates before making files', (context) => {
  const app = fixture(context, { loggedOut: true })
  assert.throws(() => linkDevelopment(app, 'visits', settings, app.execute), /gh auth login/)
  assert.equal(fs.existsSync(path.join(app.directory, '.mercato')), false)
  assert.equal(fs.existsSync(path.join(app.directory, '.git')), false)
  assert.deepEqual(app.calls.map((call) => [call.command, ...call.args]), [['gh', 'auth', 'status']])
})

for (const registration of [
  'export const enabledModules = []\n',
  "export const enabledModules = [{ id: 'visits', from: '@fixture/visits' }]\n",
  "export const enabledModules = [{ id: 'visits' }]\n",
  "// { id: 'visits', from: '@app' }\nexport const enabledModules = []\n",
  "export const enabledModules = [{ id: 'visits', from: '@app' }, { id: 'visits', from: '@fixture/visits' }]\n",
  "export const enabledModules = [{ id: 'visits', from: '@app', ['from']: '@fixture/visits' }]\n",
  "export const enabledModules = [{ id: 'visits', from: '@app', ...override }]\n",
]) {
  test(`development rejects inactive or nonlocal registration before cloning: ${registration.trim()}`, context => {
    const app = fixture(context)
    fs.writeFileSync(path.join(app.directory, 'src/modules.ts'), registration)
    const originalSource = fs.readFileSync(path.join(app.directory, 'src/modules/visits/index.ts'), 'utf8')
    assert.throws(() => linkDevelopment(app, 'visits', settings, app.execute), /enabled once as a local @app module/)
    assert.equal(fs.existsSync(path.join(app.directory, '.mercato')), false)
    assert.equal(fs.readFileSync(path.join(app.directory, 'src/modules.ts'), 'utf8'), registration)
    assert.equal(fs.readFileSync(path.join(app.directory, 'src/modules/visits/index.ts'), 'utf8'), originalSource)
    assert.deepEqual(app.calls.map(call => [call.command, ...call.args]), [['gh', 'auth', 'status']])
  })
}

test('development checks authentication first, then accepts typed literal @app registration', context => {
  const app = fixture(context, { loggedOut: true })
  fs.writeFileSync(path.join(app.directory, 'src/modules.ts'), 'export const enabledModules = []\n')
  assert.throws(() => linkDevelopment(app, 'visits', settings, app.execute), /gh auth login/)
  const ready = fixture(context)
  fs.writeFileSync(path.join(ready.directory, 'src/modules.ts'), "export const enabledModules = ([{ 'id': 'visits', 'from': '@app' }] as const) satisfies readonly unknown[]\n")
  assert.equal(linkDevelopment(ready, 'visits', settings, ready.execute).repository, settings.repository)
})

test('development refuses symlink registration files and nonliteral configuration without changing files', context => {
  const app = fixture(context)
  const outside = path.join(app.root, 'outside-modules.ts')
  fs.renameSync(path.join(app.directory, 'src/modules.ts'), outside)
  fs.symlinkSync(outside, path.join(app.directory, 'src/modules.ts'))
  assert.throws(() => linkDevelopment(app, 'visits', settings, app.execute), /must be a regular file/)
  assert.equal(fs.existsSync(path.join(app.directory, '.mercato')), false)
  fs.unlinkSync(path.join(app.directory, 'src/modules.ts'))
  fs.writeFileSync(path.join(app.directory, 'src/modules.ts'), "const local = [{ id: 'visits', from: '@app' }]; export const enabledModules = local\n")
  assert.throws(() => linkDevelopment(app, 'visits', settings, app.execute), /Cannot verify visits/)
  assert.equal(fs.existsSync(path.join(app.directory, '.mercato')), false)
})

test('unowned repository clone is removed and original source is preserved', (context) => {
  const app = fixture(context, { packageName: '@other/visits', github: 'changes-before-clone' })
  assert.throws(() => linkDevelopment(app, 'visits', settings, app.execute), /does not belong/)
  assert.match(fs.readFileSync(path.join(app.directory, 'src/modules/visits/index.ts'), 'utf8'), /Original local visits/)
  assert.deepEqual(fs.readdirSync(path.join(app.directory, '.mercato/module-repos')), [])
  assert.deepEqual(fs.readdirSync(path.join(app.directory, '.mercato/module-backups')), [])
})

test('failed dependency sharing rolls back the owned clone before replacing app source', (context) => {
  const app = fixture(context)
  fs.rmSync(path.join(app.directory, 'node_modules'), { recursive: true })
  assert.throws(() => linkDevelopment(app, 'visits', settings, app.execute), /yarn install/)
  assert.match(fs.readFileSync(path.join(app.directory, 'src/modules/visits/index.ts'), 'utf8'), /Original local visits/)
  assert.deepEqual(fs.readdirSync(path.join(app.directory, '.mercato/module-repos')), [])
})

test('development refuses symlinked parents, an occupied checkout, and unowned module links', (context) => {
  const app = fixture(context)
  fs.mkdirSync(path.join(app.root, 'outside'))
  fs.symlinkSync(path.join(app.root, 'outside'), path.join(app.directory, '.mercato'))
  assert.throws(() => linkDevelopment(app, 'visits', settings, app.execute), /must not pass through symlinks/)
  assert.deepEqual(fs.readdirSync(path.join(app.root, 'outside')), [])
  fs.unlinkSync(path.join(app.directory, '.mercato'))
  fs.mkdirSync(path.join(app.directory, '.mercato/module-repos/visits'), { recursive: true })
  assert.throws(() => linkDevelopment(app, 'visits', settings, app.execute), /already exists/)
  fs.rmSync(path.join(app.directory, '.mercato/module-repos/visits'), { recursive: true })
  fs.renameSync(path.join(app.directory, 'src/modules/visits'), path.join(app.root, 'local-source'))
  fs.symlinkSync(path.join(app.root, 'local-source'), path.join(app.directory, 'src/modules/visits'))
  assert.throws(() => linkDevelopment(app, 'visits', settings, app.execute), /without matching saved/)
})

test('repository source symlinks cannot escape into the application or other checkouts', (context) => {
  const app = fixture(context)
  fs.symlinkSync('../../../../.env', path.join(app.remote, 'src/modules/visits/secret.ts'))
  run('git', ['add', '.'], app.remote, { capture: true })
  run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Unsafe source link'], app.remote, { capture: true })
  assert.throws(() => linkDevelopment(app, 'visits', settings, app.execute), /contains a symlink at secret.ts/)
  assert.match(fs.readFileSync(path.join(app.directory, 'src/modules/visits/index.ts'), 'utf8'), /Original local visits/)
  assert.deepEqual(fs.readdirSync(path.join(app.directory, '.mercato/module-repos')), [])
})

test('publisher source validation rejects forged metadata and replaced source links', (context) => {
  const app = fixture(context)
  const link = linkDevelopment(app, 'visits', settings, app.execute)
  assert.throws(() => linkedModuleDirectory(app, 'visits', { ...link, sourcePath: '../../outside' }), /invalid/)
  assert.throws(() => linkedModuleDirectory(app, 'visits', { ...link, checkoutPath: '.mercato/other' }), /invalid/)
  assert.throws(() => linkedModuleDirectory(app, 'visits', { ...link, packageName: '@other/visits' }), /does not belong/)
  fs.unlinkSync(path.join(app.directory, 'src/modules/visits'))
  fs.symlinkSync(path.join(app.directory, link.backupPath), path.join(app.directory, 'src/modules/visits'))
  assert.throws(() => linkedModuleDirectory(app, 'visits', link), /does not match/)
})

test('real framework discovery follows linked TypeScript source while retaining @app development and shared React', { skip: !process.env.OPEN_MERCATO_ROOT, timeout: 120000 }, (context) => {
  const app = fixture(context)
  const framework = fs.realpathSync(process.env.OPEN_MERCATO_ROOT)
  for (const name of ['core', 'shared', 'ui']) {
    const installed = path.join(app.directory, 'node_modules/@open-mercato', name)
    fs.mkdirSync(installed, { recursive: true })
    fs.copyFileSync(path.join(framework, 'packages', name, 'package.json'), path.join(installed, 'package.json'))
    for (const entry of ['src', 'dist']) fs.symlinkSync(path.join(framework, 'packages', name, entry), path.join(installed, entry))
  }
  fs.symlinkSync(path.join(framework, 'node_modules/react'), path.join(app.directory, 'node_modules/react'))
  writeJson(path.join(app.directory, 'package.json'), { name: 'fixture-app', private: true, dependencies: { '@open-mercato/core': require(path.join(framework, 'packages/core/package.json')).version } })
  fs.writeFileSync(path.join(app.directory, 'next.config.ts'), 'export default {}\n')
  const link = linkDevelopment(app, 'visits', settings, app.execute)
  const checkout = path.join(app.directory, link.checkoutPath)
  assert.equal(createRequire(path.join(checkout, 'package.json')).resolve('react'), createRequire(path.join(app.directory, 'package.json')).resolve('react'))
  const cli = path.join(framework, 'packages/cli/dist/bin.js')
  const generated = run(process.execPath, [cli, 'generate'], app.directory, { capture: true, allowFailure: true })
  assert.equal(generated.status, 0, `${generated.stdout}\n${generated.stderr}`)
  const generatedDirectory = path.join(app.directory, '.mercato/generated')
  const registries = () => fs.readdirSync(generatedDirectory).filter((file) => file.endsWith('.ts')).map((file) => fs.readFileSync(path.join(generatedDirectory, file), 'utf8')).join('\n')
  assert.match(registries(), /(?:src\/modules|@\/modules)\/visits\/backend\/visits\/page/)
  assert.doesNotMatch(registries(), /@fixture\/visits/)
  const reports = path.join(app.directory, 'src/modules/visits/backend/visits/reports')
  fs.mkdirSync(reports)
  fs.writeFileSync(path.join(reports, 'page.tsx'), 'export default function Reports() { return <h1>Added through app symlink</h1> }\n')
  const regenerated = run(process.execPath, [cli, 'generate'], app.directory, { capture: true, allowFailure: true })
  assert.equal(regenerated.status, 0, `${regenerated.stdout}\n${regenerated.stderr}`)
  assert.match(registries(), /(?:src\/modules|@\/modules)\/visits\/backend\/visits\/reports\/page/)
  assert.match(fs.readFileSync(path.join(checkout, 'src/modules/visits/backend/visits/reports/page.tsx'), 'utf8'), /Added through app symlink/)
  assert.match(fs.readFileSync(path.join(app.directory, 'src/modules.ts'), 'utf8'), /from: '@app'/)
})

test('Next development server renders linked repository source and sees edits made through the original app path', { skip: !process.env.OPEN_MERCATO_ROOT, timeout: 180000 }, async (context) => {
  const app = fixture(context)
  const framework = fs.realpathSync(process.env.OPEN_MERCATO_ROOT)
  const dependencies = Object.fromEntries(['next', 'react', 'react-dom', 'typescript', '@types/node', '@types/react'].map((name) => [name, require(path.join(framework, 'node_modules', name, 'package.json')).version]))
  writeJson(path.join(app.directory, 'package.json'), { name: 'fixture-next-app', private: true, dependencies })
  const installed = run('npm', ['install', '--ignore-scripts', '--no-package-lock', '--no-audit', '--no-fund'], app.directory, { capture: true, allowFailure: true })
  assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`)
  writeJson(path.join(app.directory, 'tsconfig.json'), { compilerOptions: { target: 'ES2022', jsx: 'preserve', module: 'esnext', moduleResolution: 'bundler', esModuleInterop: true, strict: true }, include: ['**/*.ts', '**/*.tsx'] })
  fs.writeFileSync(path.join(app.directory, 'next.config.ts'), `export default { turbopack: { root: ${JSON.stringify(app.directory)} } }\n`)
  fs.mkdirSync(path.join(app.directory, 'src/app'), { recursive: true })
  fs.writeFileSync(path.join(app.directory, 'src/app/layout.tsx'), 'export default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html> }\n')
  fs.writeFileSync(path.join(app.directory, 'src/app/page.tsx'), "export { default } from '../modules/visits/backend/visits/page'\n")
  const metadata = linkDevelopment(app, 'visits', settings, app.execute)
  const sourcePage = path.join(app.directory, 'src/modules/visits/backend/visits/page.tsx')
  const writePage = (label) => fs.writeFileSync(sourcePage, `'use client'\nimport { useState } from 'react'\nexport default function Visits() { const [label] = useState(${JSON.stringify(label)}); return <h1>{label}</h1> }\n`)
  writePage('Linked repository first render')
  const reservation = net.createServer()
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve) })
  const address = reservation.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolve) => reservation.close(resolve))
  const child = spawn(process.execPath, [path.join(app.directory, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port), '--turbopack'], { cwd: app.directory, detached: true, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout.on('data', (data) => { logs = `${logs}${data}`.slice(-100000) })
  child.stderr.on('data', (data) => { logs = `${logs}${data}`.slice(-100000) })
  context.after(async () => {
    if (child.exitCode === null) {
      process.kill(-child.pid, 'SIGTERM')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  })
  async function waitForLabel(label) {
    const deadline = Date.now() + 60000
    let lastResponse = ''
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(15000) })
        lastResponse = await response.text()
        if (response.ok && lastResponse.includes(`<h1>${label}</h1>`)) return
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    assert.fail(`Next did not render ${label}.\n${logs}\n${lastResponse.slice(0, 2000)}`)
  }
  await waitForLabel('Linked repository first render')
  writePage('Linked repository edit without rebuilding')
  await waitForLabel('Linked repository edit without rebuilding')
  assert.match(fs.readFileSync(path.join(app.directory, metadata.sourcePath, 'backend/visits/page.tsx'), 'utf8'), /edit without rebuilding/)
})

for (const localSource of [true, false]) {
  test(`automatic registration and source are restored when link metadata cannot be saved (local source: ${localSource})`, context => {
    const app = fixture(context)
    fs.writeFileSync(path.join(app.directory, 'src/modules.ts'), 'export const enabledModules = []\n')
    if (!localSource) fs.rmSync(path.join(app.directory, 'src/modules'), { recursive: true })
    assert.throws(() => linkDevelopment(app, 'visits', { ...settings, registerMissing: true, checkoutName: 'my-visits' }, app.execute, () => { throw new Error('metadata write refused') }), /metadata write refused/)
    assert.equal(fs.readFileSync(path.join(app.directory, 'src/modules.ts'), 'utf8'), 'export const enabledModules = []\n')
    assert.equal(fs.existsSync(path.join(app.directory, 'src/modules')), localSource)
    if (localSource) assert.match(fs.readFileSync(path.join(app.directory, 'src/modules/visits/index.ts'), 'utf8'), /Original local visits/)
    assert.deepEqual(fs.readdirSync(path.join(app.directory, '.mercato/module-repos')), [])
    assert.deepEqual(fs.readdirSync(path.join(app.directory, '.mercato/module-backups')), [])
    const linked = linkDevelopment(app, 'visits', { ...settings, registerMissing: true }, app.execute)
    assert.equal(Boolean(linked.backupPath), localSource)
    assert.match(fs.readFileSync(path.join(app.directory, 'src/modules.ts'), 'utf8'), /id: 'visits', from: '@app'/)
  })
}
