const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { scaffold, registration } = require('../dist/scaffold.js')
const { findApp, writeJson, readJson, run } = require('../dist/common.js')
const { preparePackage, validateSettings, moduleInfo, licenseHolder, npmInstallLocator } = require('../dist/package.js')
const { addTopics, exportPackage, githubState, publish, publishRepository, tagRelease, loadConfig, saveConfig } = require('../dist/publish.js')
const { parse } = require('../dist/cli.js')
const { installFromInput } = require('../dist/install.js')

const settings = { packageName: '@fixture/visits', version: '0.1.0', repository: '', access: 'public' }

function fixture(context) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mercato-module-test-'))
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
  assert.match(fs.readFileSync(path.join(directory, 'index.ts'), 'utf8'), /version: '0\.1\.0',\n {2}description: '',\n {2}license: '',\n/)
  assert.equal(readJson(path.join(directory, 'i18n/en.json'))['visits.title'], 'Visits')
  assert.throws(() => scaffold(app, 'visits'), /already exists/)
  assert.equal(fs.readFileSync(path.join(app.directory, 'src/modules.ts'), 'utf8'), before)
  const described = scaffold(app, 'visit_notes', "Keeps the team's notes \\ for visits.")
  assert.match(fs.readFileSync(path.join(described, 'index.ts'), 'utf8'), /version: '0\.1\.0',\n {2}description: 'Keeps the team\\'s notes \\\\ for visits\.',\n {2}license: '',\n {2}ejectable: true,/)
  assert.equal(moduleInfo(described).description, "Keeps the team's notes \\ for visits.")
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
  assert.match(help.stdout, /npx create-mercato-module install @fastwhitecat\/integration-ksef-direct@0\.1\.8\n/, 'the npm example is a module the catalog verifies')
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
  assert.equal(prepared.manifest.peerDependencies['@open-mercato/core'], '^0.9.0', 'peers accept later compatible framework releases')
  assert.equal(prepared.manifest.devDependencies['@open-mercato/core'], '0.9.0', 'the module repository builds against the app version')
  assert.equal(prepared.manifest.license, 'UNLICENSED')
  assert.equal(prepared.manifest.description, 'Open Mercato module: visits')
  assert.deepEqual(readJson(path.join(destination, 'package.json')).keywords, ['open-mercato', 'open-mercato-module'])
  assert.equal(prepared.manifest.homepage, undefined, 'no repository, no homepage')
  fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(destination, 'node_modules'))
  fs.rmSync(path.join(destination, 'dist'), { recursive: true })
  run(process.execPath, ['build.cjs'], destination, { capture: true })
  assert.ok(fs.existsSync(path.join(destination, 'dist/modules/visits/backend/visits/page.js')))
  assert.ok(fs.existsSync(path.join(destination, 'dist/modules/visits/assets/mark.svg')))
})

test('published source can be linked into a host while compiled imports remain valid ESM', async (context) => {
  const { app, directory, destination } = fixture(context)
  addFile(directory, 'data/validators.ts', 'export const value = 42\n')
  addFile(directory, 'lib/helpers/index.ts', 'export const helper = 7\n')
  addFile(directory, 'lib/native.js', 'export const native = 3\n')
  addFile(directory, 'commands/record.ts', [
    "import { value } from '../data/validators.js'",
    "export { helper } from '@/modules/visits/lib/helpers'",
    "export { native } from '../lib/native.js'",
    "export const load = () => import('../data/validators')",
    'export { value }',
  ].join('\n'))
  preparePackage(app, 'visits', settings, destination)
  const source = fs.readFileSync(path.join(destination, 'src/modules/visits/commands/record.ts'), 'utf8')
  assert.match(source, /from "\.\.\/data\/validators"/)
  assert.match(source, /from "\.\.\/lib\/helpers\/index"/)
  assert.match(source, /import\("\.\.\/data\/validators"\)/)
  assert.match(source, /from "\.\.\/lib\/native\.js"/)
  const output = path.join(destination, 'dist/modules/visits/commands/record.js')
  const compiled = fs.readFileSync(output, 'utf8')
  assert.match(compiled, /from "\.\.\/data\/validators\.js"/)
  assert.match(compiled, /from "\.\.\/lib\/helpers\/index\.js"/)
  const module = await import(pathToFileURL(output).href)
  assert.equal(module.value, 42)
  assert.equal(module.helper, 7)
  assert.equal(module.native, 3)
  assert.equal((await module.load()).value, 42)
  // The build.cjs shipped to module repositories must preserve this split too.
  fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(destination, 'node_modules'))
  run(process.execPath, ['build.cjs'], destination, { capture: true })
  assert.match(fs.readFileSync(output, 'utf8'), /from "\.\.\/data\/validators\.js"/)
  assert.equal(fs.readFileSync(path.join(destination, 'src/modules/visits/commands/record.ts'), 'utf8'), source)
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

test('packages host module presence checks without freezing the publishing app configuration', async (context) => {
  const { app, directory, destination } = fixture(context)
  const source = "import { enabledModules as active } from '@/modules'\nexport const available = () => active.some((module) => module.id === 'customers')\nexport const shadow = (active: { id: string }[]) => active.some(module => module.id === 'customers')\n"
  const original = addFile(directory, 'lib/available.ts', source)
  const prepared = preparePackage(app, 'visits', settings, destination)
  assert.equal(fs.readFileSync(original, 'utf8'), source)
  assert.equal(prepared.manifest.peerDependencies['@open-mercato/shared'], '^0.9.0')
  const shared = path.join(destination, 'node_modules/@open-mercato/shared')
  writeJson(path.join(shared, 'package.json'), { name: '@open-mercato/shared', type: 'module', exports: { './lib/modules/registry': './registry.js' } })
  fs.writeFileSync(path.join(shared, 'registry.js'), 'let modules = []; export const getModules = () => modules; export const registerModules = (next) => { modules = next }\n')
  const registry = await import(pathToFileURL(path.join(shared, 'registry.js')).href)
  const output = path.join(destination, 'dist/modules/visits/lib/available.js')
  assert.doesNotMatch(fs.readFileSync(output, 'utf8'), /@\/modules/)
  const loaded = await import(pathToFileURL(output).href)
  assert.equal(loaded.available(), false)
  registry.registerModules([{ id: 'customers' }])
  assert.equal(loaded.available(), true)
  registry.registerModules([{ id: 'auth' }])
  assert.equal(loaded.available(), false)
  assert.equal(loaded.shadow([{ id: 'customers' }]), true)
  fs.symlinkSync(path.resolve(__dirname, '../node_modules/typescript'), path.join(destination, 'node_modules/typescript'))
  run(process.execPath, ['build.cjs'], destination, { capture: true })
  assert.doesNotMatch(fs.readFileSync(output, 'utf8'), /@\/modules/)
})

test('does not silently translate app configuration, mutations or client module imports', (context) => {
  const { app, directory, destination } = fixture(context)
  const source = addFile(directory, 'lib/available.ts', '')
  for (const content of [
    "import { enabledModules } from '@/modules'; export const config = enabledModules",
    "import { enabledModules } from '@/modules'; export const config = enabledModules.some(m => m.from === '@app')",
    "import { enabledModules } from '@/modules'; enabledModules.push({ id: 'other' })",
    "import * as config from '@/modules'; export const modules = config.enabledModules",
    "'use client'; import { enabledModules } from '@/modules'; export const available = () => enabledModules.some(m => m.id === 'customers')",
  ]) {
    fs.writeFileSync(source, content)
    assert.throws(() => preparePackage(app, 'visits', settings, destination), /Cannot package/)
    assert.ok(!fs.existsSync(destination))
  }
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

for (const conventionFile of [
  'data/entities.ts', 'data/entities.override.ts', 'data/schema.ts',
  'db/entities.ts', 'db/entities.override.ts', 'db/schema.ts',
  'data/entities.tsx', 'db/schema.tsx',
]) {
  test(`preserves discoverable entity source for ${conventionFile} in exported packages and repository rebuilds`, async (context) => {
    const { app, directory, destination } = fixture(context)
    addFile(directory, 'lib/decorators.ts', 'export const Entity = () => (target: Function) => undefined\nexport const Property = () => (target: object, key: string) => undefined\n')
    addFile(directory, conventionFile, [
      "import { Entity, Property } from '@/modules/visits/lib/decorators'",
      "@Entity()",
      'export class Visit {',
      '  @Property()',
      "  title: string = 'hello'",
      '}',
    ].join('\n'))
    preparePackage(app, 'visits', settings, destination)

    const mirror = path.join(destination, 'dist/modules/visits', conventionFile)
    assert.ok(fs.existsSync(mirror), 'host convention-file scanners must see TypeScript class declarations in dist')
    const source = fs.readFileSync(mirror, 'utf8')
    const ts = require('typescript')
    const parsed = ts.createSourceFile(mirror, source, ts.ScriptTarget.Latest, true)
    const exportedClasses = parsed.statements.filter(node => ts.isClassDeclaration(node) && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
    assert.deepEqual(exportedClasses.map(node => node.name.text), ['Visit'])
    assert.match(source, /from "\.\.\/lib\/decorators\.js"/)
    assert.ok(!source.includes('@/'))

    const runtime = mirror.replace(/\.tsx?$/, '.js')
    const loaded = await import(pathToFileURL(runtime).href)
    assert.equal(new loaded.Visit().title, 'hello')
    assert.equal(readJson(path.join(destination, 'package.json')).exports['./*.ts'].default, './dist/*.js')

    // Modules built later in their dedicated GitHub repo use this shipped
    // builder rather than the publisher's preparePackage implementation.
    fs.symlinkSync(path.resolve(__dirname, '../node_modules'), path.join(destination, 'node_modules'))
    run(process.execPath, ['build.cjs'], destination, { capture: true })
    assert.equal(fs.readFileSync(mirror, 'utf8'), source)
    assert.ok(fs.existsSync(runtime))
  })
}

test('rewrites import types and root self aliases; rejects CommonJS constructs before export', (context) => {
  const { app, directory, destination } = fixture(context)
  const source = addFile(directory, 'types.ts', "export type Info = typeof import('@/modules/visits').metadata\n")
  preparePackage(app, 'visits', settings, destination)
  assert.match(fs.readFileSync(path.join(destination, 'src/modules/visits/types.ts'), 'utf8'), /import\("\.\/index"\)/)
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
  const publication = { ...settings, repository: 'fixture/visits', license: 'MIT' }
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
  assert.match(run('git', ['--git-dir', remote, 'show', 'main:LICENSE'], root, { capture: true }).stdout, /^MIT License/)
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

test('an npm rejection after the GitHub push names the created repository and its release commit', (context) => {
  const { app, root } = fixture(context)
  const remote = path.join(root, 'module.git')
  const publication = { ...settings, repository: 'fixture/visits' }
  const calls = []
  function execute(command, args, cwd, options) {
    calls.push([command, ...args])
    if (command === 'npm' && args[0] === 'view') return { status: 1, stdout: '', stderr: 'npm error code E404' }
    if (command === 'npm' && args[0] === 'publish') throw new Error('npm failed (exit 1). Fix the reported error and retry.')
    if (command === 'npm') return { status: 0, stdout: 'fixture', stderr: '' }
    if (command !== 'gh') return run(command, args, cwd, options)
    if (args[0] === 'auth') return { status: 0, stdout: '', stderr: '' }
    if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: '{"login":"fixture","id":123}', stderr: '' }
    if (args[0] === 'api') return { status: fs.existsSync(remote) ? 0 : 1, stdout: '{}', stderr: 'HTTP 404' }
    if (args[1] === 'create') return run('git', ['init', '--bare', '--initial-branch=main', remote], root, { capture: true })
    if (args[1] === 'clone') return run('git', ['clone', remote, args[3]], cwd, { capture: true })
    throw new Error(`Unexpected gh command: ${args.join(' ')}`)
  }
  const prepared = exportPackage(app, 'visits', publication)
  const commit = () => run('git', ['--git-dir', remote, 'rev-parse', 'main'], root, { capture: true }).stdout.trim()
  assert.throws(() => publish(prepared, publication, execute, { expectedHead: null }), (error) => {
    assert.match(error.message, /npm failed/)
    assert.match(error.message, new RegExp(`repository fixture/visits was created \\(PUBLIC\\) and already has its release commit ${commit().slice(0, 12)}`))
    assert.match(error.message, /run publish again with the same version/)
    return true
  })
  assert.ok(!calls.some((call) => call.includes('git/refs')), 'a release npm rejected must not be tagged')
  assert.ok(!calls.some((call) => call[1] === 'repo' && call[2] === 'edit'), 'topics follow an accepted release')
})

test('an accepted release gives the repository its topics; a refused topic never fails the release', (context) => {
  const { app, root } = fixture(context)
  const remote = path.join(root, 'module.git')
  const publication = { ...settings, repository: 'fixture/visits' }
  for (const topicsStatus of [0, 1]) {
    const calls = []
    function execute(command, args, cwd, options) {
      calls.push([command, ...args])
      if (command === 'npm' && args[0] === 'view') return { status: 1, stdout: '', stderr: 'npm error code E404' }
      if (command === 'npm') return { status: 0, stdout: 'fixture', stderr: '' }
      if (command !== 'gh') return run(command, args, cwd, options)
      if (args[0] === 'auth') return { status: 0, stdout: '', stderr: '' }
      if (args[0] === 'api' && args[1] === 'user') return { status: 0, stdout: '{"login":"fixture","id":123}', stderr: '' }
      if (args[0] === 'api' && args[1] === '--method') return { status: 0, stdout: '{}', stderr: '' }
      if (args[0] === 'api') return { status: fs.existsSync(remote) ? 0 : 1, stdout: '{}', stderr: 'HTTP 404' }
      if (args[1] === 'create') return run('git', ['init', '--bare', '--initial-branch=main', remote], root, { capture: true })
      if (args[1] === 'clone') return run('git', ['clone', remote, args[3]], cwd, { capture: true })
      if (args[1] === 'edit') return { status: topicsStatus, stdout: '', stderr: topicsStatus ? 'HTTP 403' : '' }
      throw new Error(`Unexpected gh command: ${args.join(' ')}`)
    }
    const version = { ...publication, version: `0.1.${topicsStatus}` }
    const released = publish(exportPackage(app, 'visits', version), version, execute)
    assert.equal(released.tag, version.version)
    const create = calls.find((call) => call[1] === 'repo' && call[2] === 'create')
    if (create) assert.deepEqual(create.slice(-2), ['--description', 'Open Mercato module: visits'])
    const published = calls.findIndex((call) => call[0] === 'npm' && call[1] === 'publish')
    const topics = calls.findIndex((call) => call[1] === 'repo' && call[2] === 'edit')
    assert.ok(topics > published, 'topics follow npm publication')
    assert.deepEqual(calls[topics], ['gh', 'repo', 'edit', 'fixture/visits', '--add-topic', 'open-mercato-module', '--add-topic', 'open-mercato'])
  }
  assert.doesNotThrow(() => addTopics('fixture/visits', root, () => { throw new Error('gh did not finish in time') }))
})

test('releases are tagged with the bare version so the generated v* workflow does not publish again', () => {
  const sha = 'a'.repeat(40)
  const calls = []
  assert.deepEqual(tagRelease('fixture/visits', sha, '1.2.3', '/tmp', (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: '{}', stderr: '' } }), { tag: '1.2.3' })
  assert.deepEqual(calls, [['gh', 'api', '--method', 'POST', 'repos/fixture/visits/git/refs', '-f', 'ref=refs/tags/1.2.3', '-f', `sha=${sha}`]])
  const existing = tagRelease('fixture/visits', sha, '1.2.3', '/tmp', () => ({ status: 1, stdout: '', stderr: 'gh: Reference already exists (HTTP 422)' }))
  assert.match(existing.tagWarning, /release is published, but fixture\/visits has no 1\.2\.3 tag \(the tag 1\.2\.3 already exists\)/)
  assert.match(tagRelease('fixture/visits', sha, '1.2.3', '/tmp', () => ({ status: 1, stdout: '', stderr: 'HTTP 403' })).tagWarning, /GitHub refused the request.*gh api --method POST/)
  assert.match(tagRelease('fixture/visits', sha, '1.2.3', '/tmp', () => ({ status: 1, stdout: '', stderr: 'gh: Object does not exist (HTTP 422)' })).tagWarning, /GitHub refused the request/)
  assert.match(tagRelease('fixture/visits', sha, '1.2.3', '/tmp', () => { throw new Error('gh api did not finish in time') }).tagWarning, /gh did not complete the request/, 'a published release never fails on its tag')
})

test('package metadata takes the module description and links the dedicated repository', (context) => {
  const { app, directory, destination } = fixture(context)
  const index = path.join(directory, 'index.ts')
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace("  description: '',", "  description: 'Plans customer visits.',"))
  const prepared = preparePackage(app, 'visits', { ...settings, repository: 'fixture/visits' }, destination)
  assert.equal(prepared.manifest.description, 'Plans customer visits.')
  assert.deepEqual(prepared.manifest.keywords, ['open-mercato', 'open-mercato-module'])
  assert.equal(prepared.manifest.homepage, 'https://github.com/fixture/visits#readme')
  assert.deepEqual(prepared.manifest.bugs, { url: 'https://github.com/fixture/visits/issues' })
})

test('the chosen license reaches package.json, and MIT ships its LICENSE text', (context) => {
  const { app, directory, root } = fixture(context)
  const author = process.env.GIT_AUTHOR_NAME
  process.env.GIT_AUTHOR_NAME = 'Ada Lovelace'
  context.after(() => { if (author === undefined) delete process.env.GIT_AUTHOR_NAME; else process.env.GIT_AUTHOR_NAME = author })
  const mit = preparePackage(app, 'visits', { ...settings, license: 'MIT' }, path.join(root, 'mit'))
  assert.equal(mit.manifest.license, 'MIT')
  assert.match(fs.readFileSync(path.join(root, 'mit/LICENSE'), 'utf8'), /^MIT License\n\nCopyright \(c\) \d{4} Ada Lovelace\n/, 'the Git author holds the copyright')
  const unset = preparePackage(app, 'visits', settings, path.join(root, 'unset'))
  assert.equal(unset.manifest.license, 'UNLICENSED', 'no choice keeps the earlier default')
  assert.equal(unset.licenseDefaulted, true)
  assert.equal(mit.licenseDefaulted, false)
  assert.ok(!fs.existsSync(path.join(root, 'unset/LICENSE')))
  const index = path.join(directory, 'index.ts')
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace("  license: '',", "  license: 'Apache-2.0',"))
  assert.equal(preparePackage(app, 'visits', settings, path.join(root, 'declared')).manifest.license, 'Apache-2.0')
  assert.ok(!fs.existsSync(path.join(root, 'declared/LICENSE')), 'only the MIT text ships with the tool')
  assert.throws(() => validateSettings({ ...settings, license: 'MIT; rm -rf /' }), /SPDX license/)
  delete process.env.GIT_AUTHOR_NAME
  const answers = (replies) => (command) => ({ status: replies[command] === undefined ? 1 : 0, stdout: `${replies[command] ?? ''}\n`, stderr: '' })
  assert.equal(licenseHolder(app, settings, answers({ git: 'Grace Hopper', npm: 'grace' })), 'Grace Hopper')
  assert.equal(licenseHolder(app, settings, answers({ npm: 'grace' })), 'grace', 'the npm user when Git has no name')
  assert.equal(licenseHolder(app, settings, answers({})), '@fixture/visits authors', 'the package authors only when both are missing')
  assert.equal(licenseHolder(app, settings, () => { throw new Error('npm is missing') }), '@fixture/visits authors')
  assert.doesNotThrow(() => validateSettings({ ...settings, license: '(MIT OR Apache-2.0)' }))
})

test('generated module README uses the tool install command and explains the Yarn age gate', (context) => {
  const { app, destination } = fixture(context)
  preparePackage(app, 'visits', { ...settings, repository: 'fixture/visits', version: '0.2.0' }, destination)
  const readme = fs.readFileSync(path.join(destination, 'README.md'), 'utf8')
  assert.match(readme, /npx create-mercato-module install @fixture\/visits\n/)
  assert.match(readme, /npx create-mercato-module install fixture\/visits@0\.2\.0/)
  assert.match(readme, /5 days after publication \(Yarn `npmMinimalAgeGate`\).*`--preapprove-package`/)
  assert.match(readme, /tagged <version> without the v, so they do not start this workflow/)
  assert.doesNotMatch(readme, /yarn mercato module add/)
  assert.match(readme, /## Open Mercato Modules\n\nList this module in \[Open Mercato Modules\]\(https:\/\/modules\.openmercato\.com\/submit\?npm=@fixture\/visits\)/)
  assert.match(readme, /`npx create-mercato-module describe visits` prints its catalog entry/)
  assert.doesNotMatch(readme, /!\[|\/badge\//, 'no catalog badge before the module is listed')
  const restricted = path.join(destination, '..', 'restricted')
  preparePackage(app, 'visits', { ...settings, access: 'restricted' }, restricted)
  assert.doesNotMatch(fs.readFileSync(path.join(restricted, 'README.md'), 'utf8'), /Open Mercato Modules/, 'the catalog lists public packages only')
})

test('generated commands name an unscoped package with npm: so install does not take it for a GitHub repository', (context) => {
  const { app, destination } = fixture(context)
  preparePackage(app, 'visits', { ...settings, packageName: 'mercato-visits' }, destination)
  const readme = fs.readFileSync(path.join(destination, 'README.md'), 'utf8')
  assert.match(readme, /npx create-mercato-module install npm:mercato-visits\n/)
  assert.match(readme, /npx create-mercato-module link npm:mercato-visits\n/)
  assert.equal(npmInstallLocator('@fixture/visits'), '@fixture/visits')
  for (const version of ['', '@0.1.0']) {
    const calls = []
    installFromInput(app, `${npmInstallLocator('mercato-visits')}${version}`, {}, (command, args) => {
      calls.push([command, ...args])
      if (command === 'gh') throw new Error('an npm package must not reach GitHub')
      return { status: 0, stdout: '', stderr: '' }
    })
    assert.deepEqual(calls, [['yarn', 'mercato', 'module', 'add', `mercato-visits${version}`, '--allow-third-party']])
  }
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
