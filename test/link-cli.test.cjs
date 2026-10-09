const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync, spawn } = require('node:child_process')
const http = require('node:http')
const { run, writeJson } = require('../dist/common.js')
const { preparePackage } = require('../dist/package.js')
const { parse } = require('../dist/cli.js')
const { githubRepository } = require('../dist/link.js')
const { loadConfig } = require('../dist/config.js')

// All fixtures are created locally. Only gh's transport and npm's metadata /
// submission are replaced; cloning, editing, packing, commits and pushes are real.
function fixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-link-cli-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const app = { directory: path.join(root, 'app'), manifest: { name: 'fixture-app', private: true, dependencies: { '@open-mercato/core': '0.9.0', '@open-mercato/shared': '0.9.0', '@open-mercato/ui': '0.9.0', react: '19.0.0' } } }
  writeJson(path.join(app.directory, 'package.json'), app.manifest)
  fs.mkdirSync(path.join(app.directory, 'src/modules/visits'), { recursive: true })
  fs.writeFileSync(path.join(app.directory, 'src/modules/visits/index.ts'), "export const metadata = { name: 'visits', title: 'Repository visits', version: '0.1.0' }\n")
  fs.writeFileSync(path.join(app.directory, 'src/modules.ts'), "// Preserve other modules\nexport const enabledModules = [{ id: 'auth', from: '@open-mercato/core' }]\n")
  for (const [name, version] of Object.entries(app.manifest.dependencies)) writeJson(path.join(app.directory, 'node_modules', name, 'package.json'), { name, version })
  const settings = { packageName: options.packageName || '@fixture/visits', repository: 'release-checks/visits-example', version: '0.1.0', access: 'public' }
  const exported = path.join(root, 'export')
  preparePackage(app, 'visits', settings, exported)
  fs.writeFileSync(path.join(exported, 'README.md'), '# Keep custom documentation\n')
  fs.mkdirSync(path.join(exported, 'src/modules/visits/__tests__'))
  fs.writeFileSync(path.join(exported, 'src/modules/visits/__tests__/author.test.ts'), 'export const authorTest = true\n')
  if (options.remoteManifest !== undefined) writeJson(path.join(exported, 'package.json'), options.remoteManifest)
  run('git', ['init', '-q', '-b', 'main'], exported, { capture: true })
  run('git', ['add', '.'], exported, { capture: true })
  run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Module snapshot'], exported, { capture: true })
  const githubRoot = path.join(root, 'github')
  const bare = path.join(githubRoot, `${settings.repository}.git`)
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  run('git', ['clone', '--bare', exported, bare], root, { capture: true })
  writeJson(`${bare}.json`, { private: false })
  if (options.localSource) fs.writeFileSync(path.join(app.directory, 'src/modules/visits/index.ts'), "export const local = 'Preserve my original source'\n")
  else fs.rmSync(path.join(app.directory, 'src/modules/visits'), { recursive: true })
  if (options.registration) fs.writeFileSync(path.join(app.directory, 'src/modules.ts'), options.registration)
  fs.writeFileSync(path.join(app.directory, '.gitignore'), 'node_modules\n.mercato/\n')
  if (options.appGit) {
    run('git', ['init', '-q', '-b', 'main'], app.directory, { capture: true })
    run('git', ['remote', 'add', 'origin', 'https://example.invalid/my-app.git'], app.directory, { capture: true })
    run('git', ['add', '.'], app.directory, { capture: true })
    run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'Application'], app.directory, { capture: true })
  }
  const binary = path.join(root, 'bin')
  fs.mkdirSync(binary)
  const npmPath = fs.realpathSync(spawnSync('which', ['npm'], { encoding: 'utf8' }).stdout.trim())
  const calls = path.join(root, 'npm-calls.jsonl')
  const published = path.join(root, 'published.json')
  fs.writeFileSync(path.join(binary, 'npm'), `#!${process.execPath}\nconst fs=require('node:fs'),{spawnSync}=require('node:child_process');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');if(a[0]==='whoami'){console.log('fixture');process.exit(0)}if(a[0]==='view'){if(a[2]==='repository'){${options.realNpmMetadata ? `const r=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(npmPath)},...a],{stdio:'inherit'});process.exit(r.status??1);` : ''}console.log(${JSON.stringify(JSON.stringify(options.npmRepository === undefined ? { type: 'git', url: `git+https://github.com/${settings.repository}.git` } : options.npmRepository))});process.exit(${options.npmMissing ? 1 : 0})}console.error('npm error code E404');process.exit(1)}if(a[0]==='publish'){fs.writeFileSync(${JSON.stringify(published)},JSON.stringify(a));process.exit(0)}const r=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(npmPath)},...a],{stdio:'inherit'});process.exit(r.status??1)\n`, { mode: 0o755 })
  const ghShim = path.resolve(__dirname, 'release-e2e/gh-shim.mjs')
  fs.writeFileSync(path.join(binary, 'gh'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');${options.loggedOut ? "if(process.argv[2]==='auth')process.exit(1);" : ''}const r=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(ghShim)},...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status??1)\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(binary, 'yarn'), `#!${process.execPath}\nrequire('node:fs').writeFileSync('generated.txt',require('node:fs').readFileSync('src/modules.ts'))\n`, { mode: 0o755 })
  function cliOptions(extra = {}) {
    return { cwd: app.directory, encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: `${binary}${path.delimiter}${process.env.PATH}`, RELEASE_E2E_GITHUB_ROOT: githubRoot, NPM_TOKEN: '', NODE_AUTH_TOKEN: '', GH_TOKEN: '', GITHUB_TOKEN: '', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', ...extra } }
  }
  function cli(args, extra = {}) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/cli.cjs'), ...args], cliOptions(extra))
    return { ...result, output: `${result.stdout}\n${result.stderr}` }
  }
  async function cliAsync(args, extra = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve(__dirname, '../bin/cli.cjs'), ...args], cliOptions(extra))
      let output = ''
      child.stdout.on('data', data => { output += data })
      child.stderr.on('data', data => { output += data })
      child.once('error', reject)
      child.once('close', status => resolve({ status, output }))
    })
  }
  return { root, app, settings, bare, cli, cliAsync, published, calls }
}

const inputs = ['release-checks/visits-example', 'visits-example', 'https://github.com/release-checks/visits-example', 'https://github.com/release-checks/visits-example.git', 'https://github.com/https://github.com/release-checks/visits-example.git', 'git@github.com:release-checks/visits-example.git', 'ssh://git@github.com/release-checks/visits-example.git', 'github:release-checks/visits-example', '@fixture/visits', '@fixture/visits@0.1.0', 'npm:visits']
for (const input of inputs) {
  test(`CLI links ${input} in a fresh app, infers identity, generates and safely repeats`, context => {
    const { app, cli, settings, calls } = fixture(context, input === 'npm:visits' ? { packageName: 'visits' } : {})
    const result = cli(['link', input])
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, /Next release: npx create-mercato-module publish visits/)
    const saved = loadConfig(app).modules.visits
    assert.equal(saved.packageName, settings.packageName)
    assert.equal(saved.repository, settings.repository)
    assert.equal(saved.version, '0.1.0')
    assert.equal(saved.development.backupPath, '')
    const source = path.join(app.directory, 'src/modules/visits')
    assert.equal(fs.realpathSync(source), path.join(app.directory, saved.development.sourcePath))
    assert.equal(path.isAbsolute(fs.readlinkSync(source)), false)
    const registration = fs.readFileSync(path.join(app.directory, 'generated.txt'), 'utf8')
    assert.match(registration, /id: 'visits', from: '@app'/)
    assert.match(registration, /id: 'auth', from: '@open-mercato\/core'/)
    fs.writeFileSync(path.join(source, 'edit.ts'), 'export const edit = 42\n')
    const repeated = cli(['link', input, '--no-generate'])
    assert.equal(repeated.status, 0, repeated.output)
    assert.match(fs.readFileSync(path.join(source, 'edit.ts'), 'utf8'), /42/)
    const savedRepeat = cli(['link', 'visits', '--no-generate'])
    assert.equal(savedRepeat.status, 0, savedRepeat.output)
    assert.equal(fs.readFileSync(path.join(app.directory, 'src/modules.ts'), 'utf8'), registration)
    if (input.startsWith('@') || input.startsWith('npm:')) {
      const lookups = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
      assert.ok(lookups.every(args => args[0] === 'view' && args[2] === 'repository'))
      assert.ok(lookups.every(args => args.includes('--registry=https://registry.npmjs.org/')))
    } else assert.equal(fs.existsSync(calls), false, 'GitHub links never contact npm')
  })
}

test('CLI uses optional checkout name, backs up local source, then publishes edits twice with saved settings', context => {
  const { app, cli, bare, published } = fixture(context, { localSource: true, appGit: true, registration: "export const enabledModules = [{ id: 'visits', from: '@app' }]\n" })
  const head = run('git', ['rev-parse', 'HEAD'], app.directory, { capture: true }).stdout
  const linked = cli(['link', '@fixture/visits', 'my-visits', '--no-generate'])
  assert.equal(linked.status, 0, linked.output)
  const saved = loadConfig(app).modules.visits
  assert.equal(saved.development.checkoutPath, '.mercato/module-repos/my-visits')
  assert.match(fs.readFileSync(path.join(app.directory, saved.development.backupPath, 'index.ts'), 'utf8'), /original source/)
  const checkout = path.join(app.directory, saved.development.checkoutPath)
  fs.writeFileSync(path.join(app.directory, 'src/modules/visits/feature.ts'), 'export const answer = 42\n')
  const source = fs.readFileSync(path.join(app.directory, 'src/modules/visits/feature.ts'), 'utf8')
  for (const version of ['0.1.1', '0.1.2']) {
    const result = cli(['publish', 'visits', '--yes'])
    assert.equal(result.status, 0, result.output)
    assert.match(result.output, new RegExp(`Submitted @fixture/visits@${version.replaceAll('.', '\\.')}`))
    const args = JSON.parse(fs.readFileSync(published, 'utf8'))
    const manifest = JSON.parse(run('tar', ['-xOzf', args[1], 'package/package.json'], app.directory, { capture: true }).stdout)
    assert.equal(manifest.version, version)
    assert.equal(manifest.name, '@fixture/visits')
    assert.match(run('git', ['--git-dir', bare, 'show', 'main:dist/modules/visits/feature.js'], app.directory, { capture: true }).stdout, /42/)
    assert.equal(run('git', ['--git-dir', bare, 'show', 'main:README.md'], app.directory, { capture: true }).stdout, '# Keep custom documentation\n')
    assert.equal(fs.readFileSync(path.join(checkout, 'src/modules/visits/__tests__/author.test.ts'), 'utf8'), 'export const authorTest = true\n')
    assert.equal(fs.readFileSync(path.join(app.directory, 'src/modules/visits/feature.ts'), 'utf8'), source)
    assert.equal(run('git', ['rev-parse', 'HEAD'], app.directory, { capture: true }).stdout, head)
    assert.equal(run('git', ['remote', 'get-url', 'origin'], app.directory, { capture: true }).stdout.trim(), 'https://example.invalid/my-app.git')
    assert.equal(loadConfig(app).modules.visits.lastPublishedVersion, version)
  }
  const repeated = cli(['link', 'visits', '--no-generate'])
  assert.equal(repeated.status, 0, repeated.output)
  assert.equal(loadConfig(app).modules.visits.development.checkoutPath, '.mercato/module-repos/my-visits')
  const renamed = cli(['link', 'visits', 'another-name', '--no-generate'])
  assert.equal(renamed.status, 1)
  assert.match(renamed.output, /Refusing to replace/)
})

test('CLI switches an installed package registration to @app and publishes a new linked module without a backup', context => {
  const { app, cli, bare } = fixture(context, { registration: "export const enabledModules = ([{ id: 'visits', from: '@fixture/visits', custom: true }] as const) satisfies readonly unknown[]\n" })
  const linked = cli(['link', 'release-checks/visits-example', '--no-generate'])
  assert.equal(linked.status, 0, linked.output)
  assert.match(fs.readFileSync(path.join(app.directory, 'src/modules.ts'), 'utf8'), /from: '@app', custom: true/)
  fs.writeFileSync(path.join(app.directory, 'src/modules/visits/new.ts'), "export const label = 'New linked feature'\n")
  const dry = cli(['publish', 'visits', '--dry-run'])
  assert.equal(dry.status, 0, dry.output)
  assert.match(dry.output, /@fixture\/visits@0.1.1/)
  assert.equal(loadConfig(app).modules.visits.lastPublishedVersion, undefined)
  const released = cli(['publish', 'visits', '--yes'])
  assert.equal(released.status, 0, released.output)
  assert.match(run('git', ['--git-dir', bare, 'show', 'main:dist/modules/visits/new.js'], app.directory, { capture: true }).stdout, /New linked feature/)
})

for (const [description, options, input, expected] of [
  ['missing npm package', { npmMissing: true }, '@fixture/visits', /Cannot read .* from npm/],
  ['missing repository metadata', { npmRepository: null }, '@fixture/visits', /no dedicated GitHub module repository/],
  ['another Git host', { npmRepository: { url: 'https://gitlab.com/a/b' } }, '@fixture/visits', /no dedicated GitHub module repository/],
  ['a monorepo package', { npmRepository: { url: 'https://github.com/a/b', directory: 'packages/visits' } }, '@fixture/visits', /no dedicated GitHub module repository/],
  ['wrong npm identity', { npmRepository: { url: 'https://github.com/release-checks/visits-example' } }, '@fixture/other', /holds @fixture\/visits, not @fixture\/other/],
  ['ordinary repository', { remoteManifest: { name: 'ordinary-app' } }, 'release-checks/visits-example', /not a dedicated Open Mercato module repository/],
  ['invalid module identity', { remoteManifest: { name: '@fixture/visits', mercatoModule: { id: '../escape', formatVersion: 1 } } }, 'release-checks/visits-example', /not a dedicated Open Mercato module repository/],
  ['invalid JSON shape', { remoteManifest: null }, 'release-checks/visits-example', /not a dedicated Open Mercato module repository/],
  ['GitHub authentication missing', { loggedOut: true }, 'release-checks/visits-example', /gh auth login/],
  ['repository missing', {}, 'release-checks/missing', /does not exist on GitHub yet/],
  ['conflicting registration', { registration: "export const enabledModules = [{ id: 'visits', from: '@other/package' }]\n" }, 'release-checks/visits-example', /enabled once as a local @app module/],
]) {
  test(`CLI explains ${description} without changing the app`, context => {
    const { app, cli } = fixture(context, options)
    const before = fs.readFileSync(path.join(app.directory, 'src/modules.ts'), 'utf8')
    const result = cli(['link', input, '--no-generate'])
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, expected)
    assert.equal(fs.existsSync(path.join(app.directory, '.mercato')), false)
    assert.equal(fs.existsSync(path.join(app.directory, 'src/modules/visits')), false)
    assert.equal(fs.readFileSync(path.join(app.directory, 'src/modules.ts'), 'utf8'), before)
  })
}

test('CLI preserves the legacy module/--repo form with no npm package argument', context => {
  const { app, cli } = fixture(context, { localSource: true, registration: "export const enabledModules = [{ id: 'visits', from: '@app' }]\n" })
  const result = cli(['link', 'visits', '--repo', 'https://github.com/release-checks/visits-example', '--no-generate'])
  assert.equal(result.status, 0, result.output)
  assert.equal(loadConfig(app).modules.visits.packageName, '@fixture/visits')
})

test('repository normalization and argument parsing accept simple inputs and reject unsafe paths', () => {
  for (const input of inputs.filter(input => !input.startsWith('@') && !input.startsWith('npm:') && input !== 'visits-example')) assert.equal(githubRepository(input), 'release-checks/visits-example')
  for (const input of ['https://evil.example/a/b', 'https://token@github.com/a/b', 'owner/repo/tree/main', '../repo', 'owner/repo?token=secret']) assert.throws(() => githubRepository(input), /GitHub repository/)
  assert.deepEqual(parse(['link', '@fixture/visits', 'my-visits', '--no-generate']), { command: 'link', id: '@fixture/visits', localName: 'my-visits', flags: { 'no-generate': true } })
  assert.deepEqual(parse(['link']), { command: 'link', id: '', flags: {} })
  for (const local of ['../escape', '/tmp/escape', '.hidden', 'folder/name']) assert.throws(() => parse(['link', 'owner/repo', local]), /checkout name/)
  assert.throws(() => parse(['link', 'a/b', 'local', 'extra']), /Too many/)
  assert.throws(() => parse(['init', 'a/b']), /snake_case/)
  assert.throws(() => parse(['publish', 'a/b']), /snake_case/)
})

test('CLI prompts only for the source when omitted, and never asks for an npm name when supplied', context => {
  const { root, app, cli } = fixture(context)
  const preload = path.join(root, 'interactive.cjs')
  fs.writeFileSync(preload, "Object.defineProperty(process.stdin,'isTTY',{value:true});require('node:readline/promises').createInterface=()=>({question:async(label)=>{console.log('PROMPT:'+label);return 'release-checks/visits-example'},close(){}})\n")
  const result = cli(['link'], { NODE_OPTIONS: `--require=${preload}` })
  assert.equal(result.status, 0, result.output)
  assert.equal((result.output.match(/PROMPT:/g) || []).length, 1)
  assert.match(result.output, /PROMPT:.*GitHub repository or npm package/)
  assert.equal(loadConfig(app).modules.visits.packageName, '@fixture/visits')
  const repeated = cli(['link', '@fixture/visits'], { NODE_OPTIONS: `--require=${preload}` })
  assert.equal(repeated.status, 0, repeated.output)
  assert.doesNotMatch(repeated.output, /PROMPT:/)
})

test('CLI links with an environment npm token without saving it and supports an absent modules directory', context => {
  const { app, cli } = fixture(context)
  fs.rmSync(path.join(app.directory, 'src/modules'), { recursive: true })
  const token = 'fixture-environment-npm-credential'
  const linked = cli(['link', '@fixture/visits', '--no-generate'], { NPM_TOKEN: token })
  assert.equal(linked.status, 0, linked.output)
  assert.equal(fs.lstatSync(path.join(app.directory, 'src/modules/visits')).isSymbolicLink(), true)
  assert.doesNotMatch(fs.readFileSync(path.join(app.directory, '.mercato/module-tool.json'), 'utf8'), /fixture-environment-npm-credential/)
  assert.doesNotMatch(linked.output, /fixture-environment-npm-credential/)
})

for (const registration of [
  "export const enabledModules = [{ id: 'visits', from: '@fixture/visits', ['from']: '@fixture/visits' }]\n",
  "export const enabledModules = [{ id: dynamicId, from: '@fixture/visits' }]\n",
  "export const enabledModules = [...otherModules]\n",
]) {
  test(`CLI refuses ambiguous registration without app changes: ${registration.trim()}`, context => {
    const { app, cli } = fixture(context, { registration })
    const result = cli(['link', 'release-checks/visits-example', '--no-generate'])
    assert.equal(result.status, 1, result.output)
    assert.match(result.output, /Cannot safely update/)
    assert.equal(fs.readFileSync(path.join(app.directory, 'src/modules.ts'), 'utf8'), registration)
    assert.equal(fs.existsSync(path.join(app.directory, '.mercato')), false)
  })
}

for (const token of ['', 'private-registry-fixture-token']) {
  test(`real npm metadata lookup links a module through a loopback registry (authenticated: ${Boolean(token)})`, async context => {
    const { app, settings, cliAsync } = fixture(context, { realNpmMetadata: true })
    const requests = []
    const server = http.createServer((request, response) => {
      requests.push({ url: request.url, authorization: request.headers.authorization })
      if (token && request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Authentication required' }))
        return
      }
      const metadata = { name: settings.packageName, version: settings.version, repository: { type: 'git', url: `git+https://github.com/${settings.repository}.git` } }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: metadata.name, 'dist-tags': { latest: metadata.version }, versions: { [metadata.version]: metadata } }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    context.after(() => new Promise(resolve => server.close(resolve)))
    const registry = `http://127.0.0.1:${server.address().port}/`
    const result = await cliAsync(['link', settings.packageName, '--no-generate'], { MERCATO_NPM_REGISTRY: registry, NPM_TOKEN: token })
    assert.equal(result.status, 0, result.output)
    assert.ok(requests.length > 0)
    assert.ok(requests.every(request => request.url.toLowerCase().includes('fixture%2fvisits')))
    assert.equal(loadConfig(app).modules.visits.repository, settings.repository)
    if (token) assert.ok(requests.every(request => request.authorization === `Bearer ${token}`))
  })
}
