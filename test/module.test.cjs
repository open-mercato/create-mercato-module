const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { scaffold, registration } = require('../dist/scaffold.js')
const { findApp, writeJson, readJson, run } = require('../dist/common.js')
const { preparePackage, validateSettings } = require('../dist/package.js')
const { exportPackage, githubState, publish, publishRepository, loadConfig, saveConfig } = require('../dist/publish.js')
const { parse } = require('../dist/cli.js')

const settings = { packageName: '@fixture/visits', version: '0.1.0', repository: '', access: 'public' }

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-module-test-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const app = { directory: path.join(root, 'app'), manifest: { name: 'sandbox-app', private: true, dependencies: { '@open-mercato/core': '0.9.0', '@open-mercato/shared': '0.9.0', '@open-mercato/ui': '0.9.0', react: '19.2.8', 'fixture-library': '^1.2.0' } } }
  writeJson(path.join(app.directory, 'package.json'), app.manifest)
  fs.mkdirSync(path.join(app.directory, 'src/modules'), { recursive: true })
  fs.writeFileSync(path.join(app.directory, 'src/modules.ts'), "export const enabledModules = [\n  { id: 'auth', from: '@open-mercato/core' },\n]\n")
  for (const [name, version] of Object.entries({ '@open-mercato/core': '0.9.0', '@open-mercato/shared': '0.9.0', '@open-mercato/ui': '0.9.0', react: '19.2.8', 'fixture-library': '1.2.3' })) {
    writeJson(path.join(app.directory, 'node_modules', name, 'package.json'), { name, version })
  }
  fs.writeFileSync(path.join(app.directory, '.gitignore'), 'node_modules/\n.mercato/\n.env\n')
  fs.writeFileSync(path.join(app.directory, '.env'), 'SECRET=must-not-be-published\n')
  const directory = scaffold(app, 'visits')
  fs.mkdirSync(path.join(app.directory, 'src/modules/other'), { recursive: true })
  fs.writeFileSync(path.join(app.directory, 'src/modules/other/index.ts'), 'export const privateAppCode = true\n')
  return { root, app, directory, destination: path.join(root, 'export') }
}

function addFile(directory, relative, content) {
  const file = path.join(directory, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return file
}

test('init registers and localizes a working page; refuses duplicate modules without changes', (context) => {
  const { app, directory } = fixture(context)
  assert.equal(findApp(path.join(directory, 'backend')).directory, app.directory)
  const before = fs.readFileSync(path.join(app.directory, 'src/modules.ts'), 'utf8')
  assert.match(before, /id: 'visits', from: '@app'/)
  assert.match(fs.readFileSync(path.join(directory, 'backend/visits/page.meta.ts'), 'utf8'), /requireAuth: true/)
  assert.equal(readJson(path.join(directory, 'i18n/en.json'))['visits.title'], 'Visits')
  assert.throws(() => scaffold(app, 'visits'), /already exists/)
  assert.equal(fs.readFileSync(path.join(app.directory, 'src/modules.ts'), 'utf8'), before)
})

test('init and publish outside an Open Mercato app show actionable guidance and leave files untouched', (context) => {
  const { root } = fixture(context)
  const unrelated = path.join(root, 'unrelated-project')
  fs.mkdirSync(path.join(unrelated, 'src'), { recursive: true })
  writeJson(path.join(unrelated, 'package.json'), { name: 'unrelated', private: true })
  fs.writeFileSync(path.join(unrelated, 'src/modules.ts'), 'export const enabledModules = []\n')
  const before = fs.readdirSync(unrelated, { recursive: true })
  for (const command of ['init', 'publish']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../dist/cli.js'), command, 'visits'], { cwd: unrelated, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /No Open Mercato app found here/)
    assert.ok(result.stderr.includes(unrelated))
    assert.match(result.stderr, /cd \/path\/to\/your-mercato-app/)
    assert.match(result.stderr, /npx create-mercato-app my-app/)
    assert.match(result.stderr, /No files were changed/)
    assert.deepEqual(fs.readdirSync(unrelated, { recursive: true }), before)
  }
  const help = spawnSync(process.execPath, [path.join(__dirname, '../dist/cli.js'), '--help'], { cwd: unrelated, encoding: 'utf8' })
  assert.equal(help.status, 0)
})

test('recognizes app subdirectories and distinguishes missing dependencies from an unrelated project', (context) => {
  const { app, directory } = fixture(context)
  assert.equal(findApp(path.join(directory, 'backend/visits')).directory, app.directory)
  const installed = path.join(app.directory, 'node_modules/@open-mercato/core/package.json')
  fs.unlinkSync(installed)
  assert.throws(() => findApp(app.directory), /app found, but its dependencies are not installed[\s\S]*yarn install/)
  writeJson(installed, { name: 'unrelated-package' })
  assert.throws(() => findApp(app.directory), /dependencies are not installed/)
})

test('registration uses syntax nodes, preserves comments and handles missing trailing commas', () => {
  const source = "// preserve me\nexport const enabledModules = [{ id: 'auth' }]\n"
  assert.match(registration(source, 'visits'), /^\/\/ preserve me/)
  assert.match(registration(source, 'visits'), /\{ id: 'auth' \},/)
  assert.throws(() => registration("export const enabledModules = getModules()", 'visits'), /Expected an enabledModules array/)
  assert.throws(() => registration("export const enabledModules = [{ id: 'visits' }]", 'visits'), /already registered/)
})

test('package contains only the selected module, both source/dist, assets and migration snapshots', (context) => {
  const { app, directory, destination } = fixture(context)
  addFile(directory, 'migrations/.snapshot-open-mercato.json', '{"schema":1}')
  addFile(directory, 'assets/mark.svg', '<svg/>')
  addFile(directory, '__tests__/secret.test.ts', "throw new Error('test only')")
  const prepared = preparePackage(app, 'visits', settings, destination)
  assert.ok(fs.existsSync(path.join(destination, 'src/modules/visits/index.ts')))
  assert.ok(fs.existsSync(path.join(destination, 'dist/modules/visits/backend/visits/page.js')))
  assert.ok(fs.existsSync(path.join(destination, 'dist/modules/visits/assets/mark.svg')))
  assert.ok(fs.existsSync(path.join(destination, 'src/modules/visits/migrations/.snapshot-open-mercato.json')))
  assert.ok(!fs.existsSync(path.join(destination, 'src/modules/other')))
  assert.ok(!fs.existsSync(path.join(destination, '.env')))
  assert.ok(!fs.existsSync(path.join(destination, 'src/modules/visits/__tests__')))
  assert.equal(prepared.manifest.peerDependencies['@open-mercato/core'], '0.9.0')
  assert.equal(prepared.manifest.license, 'UNLICENSED')
  fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(destination, 'node_modules'))
  fs.rmSync(path.join(destination, 'dist'), { recursive: true })
  run(process.execPath, ['build.cjs'], destination, { capture: true })
  assert.ok(fs.existsSync(path.join(destination, 'dist/modules/visits/backend/visits/page.js')))
  assert.ok(fs.existsSync(path.join(destination, 'dist/modules/visits/assets/mark.svg')))
})

test('rewrites own aliases, index imports and dynamic imports and records external dependencies', async (context) => {
  const { app, directory, destination } = fixture(context)
  addFile(directory, 'lib/value/index.ts', 'export const value = 42\n')
  addFile(directory, 'lib/plain.ts', "import { value } from '@/modules/visits/lib/value'\nexport { value }\nexport const load = () => import('./value')\n")
  addFile(directory, 'lib/dependency.ts', "export { value } from 'fixture-library/value'\n")
  const prepared = preparePackage(app, 'visits', settings, destination)
  const output = path.join(destination, 'dist/modules/visits/lib/plain.js')
  assert.match(fs.readFileSync(output, 'utf8'), /\.\/value\/index\.js/)
  const loaded = await import(pathToFileURL(output).href)
  assert.equal(loaded.value, 42)
  assert.equal((await loaded.load()).value, 42)
  assert.equal(prepared.manifest.dependencies['fixture-library'], '1.2.3')
})

test('preserves client directives and emits React automatic runtime and decorator metadata', async (context) => {
  const { app, directory, destination } = fixture(context)
  addFile(directory, 'components/Client.tsx', "'use client'\nexport const Client = () => <button>Example</button>\n")
  addFile(directory, 'data/decorators.ts', 'export const Property = () => (target: object, key: string) => undefined\n')
  addFile(directory, 'data/entities.ts', "import { Property } from './decorators'\nexport class Visit {\n @Property()\n title: string = 'hello'\n}\n")
  preparePackage(app, 'visits', settings, destination)
  const client = fs.readFileSync(path.join(destination, 'dist/modules/visits/components/Client.js'), 'utf8')
  const entity = path.join(destination, 'dist/modules/visits/data/entities.js')
  assert.match(client, /^['"]use client['"];/)
  assert.match(client, /react\/jsx-runtime/)
  assert.match(fs.readFileSync(entity, 'utf8'), /__metadata\(['"]design:type['"], String\)/)
  const loaded = await import(pathToFileURL(entity).href)
  assert.equal(new loaded.Visit().title, 'hello')
})

test('rewrites import types and root self aliases; rejects CommonJS constructs before export', (context) => {
  const { app, directory, destination } = fixture(context)
  const source = addFile(directory, 'types.ts', "export type Info = typeof import('@/modules/visits').metadata\n")
  preparePackage(app, 'visits', settings, destination)
  assert.match(fs.readFileSync(path.join(destination, 'src/modules/visits/types.ts'), 'utf8'), /import\("\.\/index\.js"\)/)
  fs.rmSync(destination, { recursive: true })
  for (const content of ["type X = import('@/lib/private').X", "import Foo = require('fixture-library'); export const value = Foo.value", "export const value = require('fixture-library')"]) {
    fs.writeFileSync(source, content)
    assert.throws(() => preparePackage(app, 'visits', settings, destination))
    assert.ok(!fs.existsSync(destination))
  }
})

test('scaffold refuses symlinked module sources and registration files', (context) => {
  const { app, root } = fixture(context)
  const modules = path.join(app.directory, 'src/modules.ts')
  const outside = path.join(root, 'modules.ts')
  fs.renameSync(modules, outside)
  fs.symlinkSync(outside, modules)
  assert.throws(() => scaffold(app, 'new_module'), /symlinks/)
  assert.ok(!fs.existsSync(path.join(app.directory, 'src/modules/new_module')))
})

for (const specifier of ['@/lib/auth', '@/.mercato/generated/entities.ids.generated', '../other/index', 'missing-package', './does-not-exist']) {
  test(`rejects non-portable import ${specifier} before writing the export`, (context) => {
    const { app, directory, destination } = fixture(context)
    addFile(directory, 'bad.ts', `import '${specifier}'\n`)
    assert.throws(() => preparePackage(app, 'visits', settings, destination))
    assert.ok(!fs.existsSync(destination))
  })
}

test('rejects symlinks, credential files, raw tokens and workspace dependencies', (context) => {
  const { app, directory, destination } = fixture(context)
  const secret = addFile(directory, '.env.production', 'secret=yes')
  assert.throws(() => preparePackage(app, 'visits', settings, destination), /credential file/)
  fs.unlinkSync(secret)
  fs.symlinkSync(path.join(app.directory, '.env'), path.join(directory, 'outside'))
  assert.throws(() => preparePackage(app, 'visits', settings, destination), /symlink/)
  fs.unlinkSync(path.join(directory, 'outside'))
  const token = addFile(directory, 'credentials.ts', `export const token = 'npm_${'x'.repeat(40)}'`)
  assert.throws(() => preparePackage(app, 'visits', settings, destination), /Possible credential/)
  fs.unlinkSync(token)
  const textToken = addFile(directory, 'config.json', JSON.stringify({ token: `npm_${'x'.repeat(40)}` }))
  assert.throws(() => preparePackage(app, 'visits', settings, destination), /Possible credential/)
  fs.unlinkSync(textToken)
  for (const [name, content] of [['.netrc', 'machine example.com'], ['store.jks', 'binary'], ['aws.ts', `export const key = 'AKIA${'A'.repeat(16)}'`], ['stripe.ts', `export const key = 'sk_live_${'a'.repeat(24)}'`]]) {
    const file = addFile(directory, name, content)
    assert.throws(() => preparePackage(app, 'visits', settings, destination), /credential/i, name)
    fs.unlinkSync(file)
  }
  addFile(directory, '.env.example', 'API_URL=\n')
  app.manifest.dependencies['@open-mercato/core'] = 'workspace:*'
  assert.throws(() => preparePackage(app, 'visits', settings, destination), /local\/Git locator/)
})

test('real npm pack produces a usable archive without changing the source app Git repository', (context) => {
  const { app } = fixture(context)
  run('git', ['init', '-q'], app.directory, { capture: true })
  run('git', ['remote', 'add', 'origin', 'https://github.com/example/whole-app.git'], app.directory, { capture: true })
  const before = run('git', ['status', '--porcelain'], app.directory, { capture: true }).stdout
  const prepared = exportPackage(app, 'visits', settings)
  const paths = run('tar', ['-tzf', prepared.archive], app.directory, { capture: true }).stdout
  assert.match(paths, /package\/src\/modules\/visits\/index\.ts/)
  assert.match(paths, /package\/dist\/modules\/visits\/index\.js/)
  assert.doesNotMatch(paths, /other\/|\.env|node_modules/)
  assert.equal(run('git', ['status', '--porcelain'], app.directory, { capture: true }).stdout, before)
  assert.equal(run('git', ['remote', 'get-url', 'origin'], app.directory, { capture: true }).stdout.trim(), 'https://github.com/example/whole-app.git')
  assert.match(prepared.integrity, /^sha512-/)
})

test('dry-run works without a source Git repository and makes no external publication calls', (context) => {
  const { app } = fixture(context)
  const result = spawnSync(process.execPath, [path.join(__dirname, '../dist/cli.js'), 'publish', 'visits', '--package', settings.packageName, '--version', '0.1.0', '--repo', 'fixture/visits', '--dry-run'], { cwd: app.directory, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Dry run complete/)
  assert.ok(!fs.existsSync(path.join(app.directory, '.git')))
  assert.ok(!fs.existsSync(path.join(app.directory, 'mercato-modules.json')))
})

test('publication checks auth/version first and invokes npm on only the prepared archive', (context) => {
  const { app } = fixture(context)
  const prepared = exportPackage(app, 'visits', settings)
  const calls = []
  function execute(command, args, cwd) {
    calls.push({ command, args, cwd })
    if (args[0] === 'view') return { status: 1, stdout: '', stderr: 'E404' }
    return { status: 0, stdout: 'fixture', stderr: '' }
  }
  publish(prepared, settings, execute)
  const publication = calls.find((entry) => entry.args[0] === 'publish')
  assert.deepEqual(publication.args, ['publish', prepared.archive, '--access', 'public', '--ignore-scripts', '--@fixture:registry=https://registry.npmjs.org/'])
  assert.equal(publication.cwd, prepared.destination)
  assert.ok(calls.every((entry) => entry.command === 'npm'))
  const blocked = []
  assert.throws(() => publish(prepared, settings, (command, args) => { blocked.push(args); return { status: 0, stdout: '0.1.0', stderr: '' } }), /already published/)
  assert.equal(blocked.length, 2)
})

test('GitHub auth/network errors never become create permission', () => {
  assert.equal(githubState('fixture/visits', '/tmp', () => ({ status: 1, stderr: 'gh: Not Found (HTTP 404)' })), 'missing')
  assert.throws(() => githubState('fixture/visits', '/tmp', () => ({ status: 1, stderr: 'HTTP 403' })), /no repository was created/)
  assert.throws(() => githubState('fixture/visits', '/tmp', () => ({ status: 1, stderr: 'connection refused' })), /no repository was created/)
})

test('dedicated repository publication creates and updates an isolated repo without changing app Git', (context) => {
  const { app, root, directory } = fixture(context)
  run('git', ['init', '-q'], app.directory, { capture: true })
  run('git', ['remote', 'add', 'origin', 'https://example.com/whole-app.git'], app.directory, { capture: true })
  const before = run('git', ['status', '--porcelain'], app.directory, { capture: true }).stdout
  const remote = path.join(root, 'module.git')
  const publication = { ...settings, repository: 'fixture/visits' }
  let creations = 0
  function execute(command, args, cwd, options) {
    if (command !== 'gh') return run(command, args, cwd, options)
    if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: '{"login":"fixture","id":123}', stderr: '' }
    if (args[0] === 'api') return { status: fs.existsSync(remote) ? 0 : 1, stdout: '{}', stderr: 'HTTP 404' }
    if (args[1] === 'create') {
      creations += 1
      return run('git', ['init', '--bare', '--initial-branch=main', remote], root, { capture: true })
    }
    if (args[1] === 'clone') return run('git', ['clone', remote, args[3]], cwd, { capture: true })
    throw new Error(`Unexpected gh command: ${args.join(' ')}`)
  }
  const first = exportPackage(app, 'visits', publication)
  publishRepository(first, publication, execute)
  assert.equal(creations, 1)
  assert.equal(JSON.parse(run('git', ['--git-dir', remote, 'show', 'main:package.json'], root, { capture: true }).stdout).name, settings.packageName)
  const updated = { ...publication, version: '0.1.1' }
  addFile(directory, 'new-feature.ts', 'export const enabled = true\n')
  const remoteHead = () => run('git', ['--git-dir', remote, 'rev-parse', 'main'], root, { capture: true }).stdout.trim()
  publishRepository(exportPackage(app, 'visits', updated), updated, execute, { expectedHead: remoteHead() })
  assert.equal(creations, 1)
  assert.equal(run('git', ['--git-dir', remote, 'rev-list', '--count', 'main'], root, { capture: true }).stdout.trim(), '2')
  assert.match(run('git', ['--git-dir', remote, 'log', '-1', '--format=%B', 'main'], root, { capture: true }).stdout, /^Release @fixture\/visits@0\.1\.1\n\nMercato-Source: app$/m)
  const released = remoteHead()
  const later = { ...publication, version: '0.1.2' }
  assert.throws(() => publishRepository(exportPackage(app, 'visits', later), later, execute, { expectedHead: 'a'.repeat(40) }), /changed after you approved/)
  assert.throws(() => publishRepository(exportPackage(app, 'visits', later), later, execute, { expectedHead: null }), /changed after you approved/)
  assert.equal(remoteHead(), released, 'an unapproved repository state must not receive a push')
  const exports = path.join(app.directory, '.mercato/module-publish')
  assert.ok(fs.readdirSync(exports).length > 1, 'recent exports may belong to a running publication')
  for (const name of fs.readdirSync(exports)) fs.utimesSync(path.join(exports, name), new Date(0), new Date(0))
  exportPackage(app, 'visits', later)
  assert.equal(fs.readdirSync(exports).length, 1, 'stale export workspaces are pruned')
  assert.equal(run('git', ['remote', 'get-url', 'origin'], app.directory, { capture: true }).stdout.trim(), 'https://example.com/whole-app.git')
  fs.unlinkSync(path.join(directory, 'new-feature.ts'))
  assert.equal(run('git', ['status', '--porcelain'], app.directory, { capture: true }).stdout, before)
  const wrong = { ...updated, packageName: '@fixture/another' }
  assert.throws(() => publishRepository(exportPackage(app, 'visits', wrong), wrong, execute), /another package/)
  assert.equal(run('git', ['--git-dir', remote, 'rev-list', '--count', 'main'], root, { capture: true }).stdout.trim(), '2')
})

test('publication preferences persist per module without credentials', (context) => {
  const { app } = fixture(context)
  saveConfig(app, 'visits', settings, true)
  assert.equal(loadConfig(app).modules.visits.lastPublishedVersion, '0.1.0')
  assert.deepEqual(Object.keys(loadConfig(app).modules), ['visits'])
})

test('validates module/package/version/repo arguments and rejects repeated flags', () => {
  assert.throws(() => parse(['init', '../other']), /snake_case/)
  assert.throws(() => parse(['publish', 'visits', '--yes', '--yes']), /repeated/)
  assert.throws(() => validateSettings({ ...settings, repository: 'owner/repo;rm -rf /' }), /GitHub repository/)
  assert.throws(() => validateSettings({ ...settings, packageName: '../package' }), /npm package/)
  assert.throws(() => validateSettings({ ...settings, version: 'latest' }), /version/)
})
