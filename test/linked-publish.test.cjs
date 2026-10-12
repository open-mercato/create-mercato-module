const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { scaffold } = require('../dist/scaffold.js')
const { run, readJson, writeJson } = require('../dist/common.js')
const { exportPackage, exportLinkedPackage, publishRepository, publicationRisks } = require('../dist/publish.js')

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-linked-publish-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const app = { directory: path.join(root, 'app'), manifest: { name: 'app', dependencies: { '@open-mercato/core': '0.9.0', '@open-mercato/shared': '0.9.0', '@open-mercato/ui': '0.9.0', react: '19.2.8' } } }
  writeJson(path.join(app.directory, 'package.json'), app.manifest)
  fs.mkdirSync(path.join(app.directory, 'src/modules'), { recursive: true })
  fs.writeFileSync(path.join(app.directory, 'src/modules.ts'), 'export const enabledModules = []\n')
  fs.writeFileSync(path.join(app.directory, '.gitignore'), '.mercato/\nnode_modules/\n')
  for (const [name, version] of Object.entries(app.manifest.dependencies)) writeJson(path.join(app.directory, 'node_modules', name, 'package.json'), { name, version })
  scaffold(app, 'visits')
  const settings = { packageName: '@fixture/visits', repository: 'fixture/visits', version: '0.1.0', access: 'public' }
  const prepared = exportPackage(app, 'visits', settings)
  const metadata = { formatVersion: 1, packageName: settings.packageName, repository: settings.repository, checkoutPath: '.mercato/module-repos/visits', sourcePath: '.mercato/module-repos/visits/src/modules/visits', backupPath: '.mercato/module-backups/visits-fixture' }
  const checkout = path.join(app.directory, metadata.checkoutPath)
  fs.cpSync(prepared.destination, checkout, { recursive: true, filter: name => !name.endsWith('.tgz') })
  run('git', ['init', '-q', '-b', 'main'], checkout)
  run('git', ['config', 'user.name', 'Fixture'], checkout)
  run('git', ['config', 'user.email', 'fixture@example.com'], checkout)
  run('git', ['remote', 'add', 'origin', 'https://github.com/fixture/visits.git'], checkout)
  run('git', ['add', '.'], checkout)
  run('git', ['commit', '-qm', 'Initial module'], checkout)
  fs.mkdirSync(path.dirname(path.join(app.directory, metadata.backupPath)), { recursive: true })
  fs.renameSync(path.join(app.directory, 'src/modules/visits'), path.join(app.directory, metadata.backupPath))
  fs.symlinkSync(path.relative(path.join(app.directory, 'src/modules'), path.join(app.directory, metadata.sourcePath)), path.join(app.directory, 'src/modules/visits'))
  run('git', ['init', '-q'], app.directory)
  run('git', ['remote', 'add', 'origin', 'https://github.com/fixture/app.git'], app.directory)
  return { app, settings, metadata, checkout }
}

test('linked publication releases app edits, preserves repository customization and leaves app Git untouched', context => {
  const { app, settings, metadata, checkout } = fixture(context)
  const version = { ...settings, version: '0.1.1' }
  const manifest = readJson(path.join(checkout, 'package.json'))
  manifest.author = 'Module author'
  manifest.scripts.check = 'echo custom-check'
  writeJson(path.join(checkout, 'package.json'), manifest)
  fs.writeFileSync(path.join(checkout, 'README.md'), '# Custom module documentation\n')
  fs.appendFileSync(path.join(checkout, '.github/workflows/publish.yml'), '\n# Custom workflow configuration\n')
  fs.writeFileSync(path.join(app.directory, 'src/modules/visits/feature.ts'), 'export const answer = 42\n')
  const originalSource = "import { label } from '@/modules/visits/lib/label'\n\nexport const answer = label\n"
  fs.mkdirSync(path.join(checkout, 'src/modules/visits/lib'))
  fs.writeFileSync(path.join(checkout, 'src/modules/visits/lib/label.ts'), "export const label = 'Keep author formatting and alias'\n")
  fs.writeFileSync(path.join(checkout, 'src/modules/visits/author-source.ts'), originalSource)
  fs.mkdirSync(path.join(checkout, 'src/modules/visits/__tests__'))
  fs.writeFileSync(path.join(checkout, 'src/modules/visits/__tests__/keep.test.ts'), 'export const originalTest = true\n')
  const before = run('git', ['status', '--porcelain'], app.directory, { capture: true }).stdout
  const originalManifest = fs.readFileSync(path.join(checkout, 'package.json'), 'utf8')
  const prepared = exportLinkedPackage(app, 'visits', version, metadata)
  assert.equal(fs.readFileSync(path.join(checkout, 'package.json'), 'utf8'), originalManifest, 'export must not change checkout version')
  assert.equal(prepared.manifest.author, 'Module author')
  assert.equal(prepared.manifest.scripts.check, 'echo custom-check')
  assert.equal(prepared.manifest.version, '0.1.1')
  assert.equal(fs.readFileSync(path.join(prepared.destination, 'README.md'), 'utf8'), '# Custom module documentation\n')
  assert.match(fs.readFileSync(path.join(prepared.destination, '.github/workflows/publish.yml'), 'utf8'), /Custom workflow/)
  const pushes = []
  publishRepository(prepared, version, (command, args, cwd, options) => {
    if (command === 'git' && args[0] === 'push') { pushes.push({ args, cwd }); return { status: 0, stdout: '', stderr: '' } }
    return run(command, args, cwd, options)
  })
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0].cwd, checkout)
  assert.equal(readJson(path.join(checkout, 'package.json')).version, '0.1.1')
  assert.match(run('git', ['show', 'HEAD:dist/modules/visits/feature.js'], checkout, { capture: true }).stdout, /42/)
  assert.equal(fs.readFileSync(path.join(checkout, 'src/modules/visits/author-source.ts'), 'utf8'), originalSource, 'release must not rewrite author source')
  assert.equal(fs.readFileSync(path.join(checkout, 'src/modules/visits/__tests__/keep.test.ts'), 'utf8'), 'export const originalTest = true\n', 'release must not delete source tests excluded from npm')
  assert.equal(run('git', ['show', 'HEAD:src/modules/visits/__tests__/keep.test.ts'], checkout, { capture: true }).stdout, 'export const originalTest = true\n')
  assert.equal(run('git', ['status', '--porcelain'], app.directory, { capture: true }).stdout, before)
  assert.equal(run('git', ['remote', 'get-url', 'origin'], app.directory, { capture: true }).stdout.trim(), 'https://github.com/fixture/app.git')
})

test('linked publication rejects wrong remote and mismatched package before packing', context => {
  const { app, settings, metadata, checkout } = fixture(context)
  assert.throws(() => exportLinkedPackage(app, 'visits', { ...settings, packageName: '@fixture/other' }, metadata), /must match/)
  run('git', ['remote', 'set-url', 'origin', 'https://github.com/fixture/wrong.git'], checkout)
  assert.throws(() => exportLinkedPackage(app, 'visits', settings, metadata), /origin does not match/)
})

test('linked publication refuses unrelated staged files without modifying working tree', context => {
  const { app, settings, metadata, checkout } = fixture(context)
  fs.writeFileSync(path.join(checkout, 'unrelated.txt'), 'keep staged\n')
  run('git', ['add', 'unrelated.txt'], checkout)
  const before = run('git', ['status', '--porcelain'], checkout, { capture: true }).stdout
  const prepared = exportLinkedPackage(app, 'visits', { ...settings, version: '0.1.2' }, metadata)
  assert.throws(() => publishRepository(prepared, settings), /staged files outside/)
  assert.equal(run('git', ['status', '--porcelain'], checkout, { capture: true }).stdout, before)
})

test('linked publication refuses unrelated staged source outside the selected module', context => {
  const { app, settings, metadata, checkout } = fixture(context)
  fs.writeFileSync(path.join(checkout, 'src/other-source.ts'), 'export const unrelated = true\n')
  run('git', ['add', 'src/other-source.ts'], checkout)
  const before = run('git', ['status', '--porcelain'], checkout, { capture: true }).stdout
  const prepared = exportLinkedPackage(app, 'visits', settings, metadata)
  assert.throws(() => publishRepository(prepared, settings), /staged files outside/)
  assert.equal(run('git', ['status', '--porcelain'], checkout, { capture: true }).stdout, before)
})

for (const relative of ['dist', 'build.cjs', 'types']) {
  test(`linked publication refuses an external ${relative} symlink before writing or deleting files`, context => {
    const { app, settings, metadata, checkout } = fixture(context)
    const prepared = exportLinkedPackage(app, 'visits', settings, metadata)
    const external = path.join(path.dirname(app.directory), `external-${relative.replace('.', '-')}`)
    if (relative === 'build.cjs') fs.writeFileSync(external, 'Do not overwrite this external file\n')
    else {
      fs.mkdirSync(path.join(external, 'modules/visits'), { recursive: true })
      fs.writeFileSync(path.join(external, 'modules/visits/sentinel.txt'), 'Do not delete this external file\n')
    }
    fs.rmSync(path.join(checkout, relative), { recursive: true, force: true })
    fs.symlinkSync(external, path.join(checkout, relative))
    const before = run('git', ['status', '--porcelain'], checkout, { capture: true }).stdout
    assert.throws(() => publishRepository(prepared, settings), /symlink/)
    const sentinel = relative === 'build.cjs' ? external : path.join(external, 'modules/visits/sentinel.txt')
    assert.match(fs.readFileSync(sentinel, 'utf8'), /Do not/)
    assert.equal(run('git', ['status', '--porcelain'], checkout, { capture: true }).stdout, before)
  })
}

test('linked publication refuses source edits made after packing without replacing the edits', context => {
  const { app, settings, metadata, checkout } = fixture(context)
  const prepared = exportLinkedPackage(app, 'visits', settings, metadata)
  const source = path.join(checkout, 'src/modules/visits/late-edit.ts')
  fs.writeFileSync(source, 'export const latestEdit = true\n')
  const before = run('git', ['status', '--porcelain'], checkout, { capture: true }).stdout
  assert.throws(() => publishRepository(prepared, settings), /changed after the archive/)
  assert.equal(fs.readFileSync(source, 'utf8'), 'export const latestEdit = true\n')
  assert.equal(run('git', ['status', '--porcelain'], checkout, { capture: true }).stdout, before)
})

test('linked publication rejects credentials and private:true in repository manifest before submission', context => {
  const { app, settings, metadata, checkout } = fixture(context)
  const manifest = readJson(path.join(checkout, 'package.json'))
  writeJson(path.join(checkout, 'package.json'), { ...manifest, customToken: `npm_${'x'.repeat(40)}` })
  assert.throws(() => exportLinkedPackage(app, 'visits', settings, metadata), /credential in package.json/)
  writeJson(path.join(checkout, 'package.json'), { ...manifest, private: true })
  assert.throws(() => exportLinkedPackage(app, 'visits', settings, metadata), /marked private: true/)
  writeJson(path.join(checkout, 'package.json'), { ...manifest, dependencies: { helper: 'git+https://example.com/helper.git' } })
  assert.throws(() => exportLinkedPackage(app, 'visits', settings, metadata), /helper.*local\/Git locator/)
  writeJson(path.join(checkout, 'package.json'), { ...manifest, scripts: { ...manifest.scripts, postinstall: 'node setup.js' } })
  const prepared = exportLinkedPackage(app, 'visits', settings, metadata)
  assert.deepEqual(prepared.installScripts, ['postinstall'])
  assert.equal(prepared.linkedBranch, 'main')
  assert.deepEqual(publicationRisks(prepared, settings, { state: 'exists', private: true, defaultBranch: 'main', head: 'a'.repeat(40) }).map((risk) => risk.flag), ['allow-install-scripts'])
  assert.deepEqual(prepared.notes, [])
  fs.writeFileSync(path.join(checkout, '.github/workflows/publish.yml'), 'jobs:\n  publish:\n    steps:\n      - uses: actions/checkout@v4\n')
  assert.match(exportLinkedPackage(app, 'visits', settings, metadata).notes.join('\n'), /pinned by tag/)
})

test('GitHub-style packing of raw repository aliases installs and discovers portable runtime in a different app', { skip: !process.env.OPEN_MERCATO_ROOT, timeout: 120000 }, async context => {
  const { app, settings, checkout } = fixture(context)
  const framework = fs.realpathSync(process.env.OPEN_MERCATO_ROOT)
  const sourceRoot = path.join(checkout, 'src/modules/visits')
  fs.mkdirSync(path.join(sourceRoot, 'lib'))
  fs.writeFileSync(path.join(sourceRoot, 'lib/label.ts'), "export const label = 'Raw alias from independent repo'\n")
  fs.mkdirSync(path.join(sourceRoot, 'api'))
  fs.writeFileSync(path.join(sourceRoot, 'api/status.ts'), "import { label } from '@/modules/visits/lib/label'\nexport const metadata = { GET: { requireAuth: true } }\nexport async function GET() { return Response.json({ label }) }\n")
  fs.symlinkSync(path.join(app.directory, 'node_modules'), path.join(checkout, 'node_modules'))
  fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(app.directory, 'node_modules/typescript'))
  fs.mkdirSync(path.join(sourceRoot, '__tests__'), { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, '__tests__/excluded.test.ts'), 'export const devOnly = true\n')
  const packed = JSON.parse(run('npm', ['pack', '--json'], checkout, { capture: true }).stdout)[0]
  assert.ok(!packed.files.some(file => file.path.includes('__tests__') || file.path.includes('.test.')), 'development tests must not ship in npm')
  const consumer = path.join(path.dirname(app.directory), 'consumer')
  const installed = path.join(consumer, 'node_modules/@fixture/visits')
  fs.mkdirSync(installed, { recursive: true })
  run('tar', ['-xzf', path.join(checkout, packed.filename), '--strip-components=1', '-C', installed], consumer, { capture: true })
  const frameworkVersion = readJson(path.join(framework, 'packages/core/package.json')).version
  writeJson(path.join(consumer, 'package.json'), { name: 'different-app', private: true, type: 'module', dependencies: { '@open-mercato/core': frameworkVersion, '@fixture/visits': '0.1.0' } })
  fs.mkdirSync(path.join(consumer, 'src/modules'), { recursive: true })
  fs.writeFileSync(path.join(consumer, 'src/modules.ts'), 'export const enabledModules = []\n')
  fs.writeFileSync(path.join(consumer, 'next.config.ts'), 'export default {}\n')
  for (const name of ['core', 'shared', 'ui']) {
    const dependency = path.join(consumer, 'node_modules/@open-mercato', name)
    fs.mkdirSync(dependency, { recursive: true })
    fs.copyFileSync(path.join(framework, 'packages', name, 'package.json'), path.join(dependency, 'package.json'))
    for (const entry of ['src', 'dist']) fs.symlinkSync(path.join(framework, 'packages', name, entry), path.join(dependency, entry))
  }
  const cli = path.join(framework, 'packages/cli/dist/bin.js')
  const enabled = run(process.execPath, [cli, 'module', 'enable', settings.packageName, '--allow-third-party'], consumer, { capture: true, allowFailure: true })
  assert.equal(enabled.status, 0, `${enabled.stdout}\n${enabled.stderr}`)
  const registryDirectory = path.join(consumer, '.mercato/generated')
  const registries = fs.readdirSync(registryDirectory).filter(file => file.endsWith('.ts')).map(file => fs.readFileSync(path.join(registryDirectory, file), 'utf8')).join('\n')
  assert.match(registries, /@fixture\/visits\/modules\/visits\/api\/status/)
  const consumerRequire = createRequire(path.join(consumer, 'package.json'))
  const route = await import(pathToFileURL(consumerRequire.resolve('@fixture/visits/modules/visits/api/status')).href)
  assert.deepEqual(await (await route.GET()).json(), { label: 'Raw alias from independent repo' })
  fs.writeFileSync(path.join(consumer, 'src/typecheck.ts'), "import { GET } from '@fixture/visits/modules/visits/api/status'\nvoid GET\n")
  writeJson(path.join(consumer, 'tsconfig.json'), { compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', types: [], paths: { '@/*': ['./src/*'] } }, files: ['src/typecheck.ts'] })
  const typechecked = run(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(consumer, 'tsconfig.json')], consumer, { capture: true, allowFailure: true })
  assert.equal(typechecked.status, 0, `${typechecked.stdout}\n${typechecked.stderr}`)
})
