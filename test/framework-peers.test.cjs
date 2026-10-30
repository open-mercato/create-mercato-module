const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { satisfiesPeer, frameworkPeerWarning } = require('../dist/framework-peers.js')
const { installFromInput } = require('../dist/install.js')
const { scaffold } = require('../dist/scaffold.js')
const { run, writeJson } = require('../dist/common.js')
const { preparePackage } = require('../dist/package.js')

test('peer ranges are judged for exact versions and caret ranges only', () => {
  for (const [version, range, expected] of [
    ['0.9.0', '0.9.0', true],
    ['0.8.1-develop.7452', '0.9.0', false],
    ['0.9.1', '^0.9.0', true],
    ['0.10.0', '^0.9.0', false],
    ['1.4.0', '^1.2.3', true],
    ['2.0.0-beta.1', '^1.2.3', false],
    ['0.9.0-rc.2', '^0.9.0-rc.1', true],
    ['0.9.1-rc.1', '^0.9.0-rc.1', false],
    ['0.0.4', '^0.0.3', false],
    ['0.9.0', '>=0.9.0 <0.10.0', undefined],
    ['local', '0.9.0', undefined],
  ]) assert.equal(satisfiesPeer(version, range), expected, `${version} ${range}`)
})

function app(context, installed) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'framework-peers-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const write = (name, manifest) => {
    fs.mkdirSync(path.join(directory, 'node_modules', name), { recursive: true })
    fs.writeFileSync(path.join(directory, 'node_modules', name, 'package.json'), JSON.stringify({ name, ...manifest }))
  }
  write('@fixture/visits', { version: '0.0.2', mercatoModule: { id: 'visits', formatVersion: 1 }, peerDependencies: { '@open-mercato/core': '0.9.0', '@open-mercato/shared': '0.9.0', '@open-mercato/ui': '0.9.0', react: '19.2.8' } })
  for (const [name, version] of Object.entries(installed)) write(name, { version })
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'app' }))
  return directory
}

test('one warning lists every framework peer the app does not satisfy', (context) => {
  const directory = app(context, { '@open-mercato/core': '0.8.1-develop.7452', '@open-mercato/ui': '0.9.0', react: '19.0.0' })
  const warning = frameworkPeerWarning(directory, '@fixture/visits')
  assert.match(warning, /@open-mercato\/core: module needs 0\.9\.0, app has 0\.8\.1-develop\.7452/)
  assert.match(warning, /@open-mercato\/shared: module needs 0\.9\.0, app has it not installed/)
  assert.doesNotMatch(warning, /@open-mercato\/ui|react/)
  assert.match(warning, /YN0060/)
  assert.equal(frameworkPeerWarning(app(context, { '@open-mercato/core': '0.9.0', '@open-mercato/shared': '0.9.0', '@open-mercato/ui': '0.9.0' }), '@fixture/visits'), undefined)
})

test('npm installation prints the framework warning once', (context) => {
  const directory = app(context, { '@open-mercato/core': '0.8.1', '@open-mercato/shared': '0.9.0', '@open-mercato/ui': '0.9.0' })
  const warnings = []
  installFromInput({ directory, manifest: {} }, '@fixture/visits', { warn: (message) => warnings.push(message) }, () => ({ status: 0, stdout: '', stderr: '' }))
  assert.equal(warnings.filter((message) => message.includes('other Open Mercato versions')).length, 1)
})

function moduleApp(context, imports) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'host-peers-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const installed = { '@open-mercato/core': '0.9.0', '@open-mercato/shared': '0.9.0', '@open-mercato/ui': '0.9.0', react: '19.2.8', '@tanstack/react-query': '5.90.2', '@tanstack/react-table': '8.21.3', zod: '4.1.12' }
  const app = { directory: path.join(root, 'app'), manifest: { name: 'app', dependencies: installed } }
  writeJson(path.join(app.directory, 'package.json'), app.manifest)
  fs.mkdirSync(path.join(app.directory, 'src/modules'), { recursive: true })
  fs.writeFileSync(path.join(app.directory, 'src/modules.ts'), 'export const enabledModules = []\n')
  for (const [name, version] of Object.entries(installed)) writeJson(path.join(app.directory, 'node_modules', name, 'package.json'), { name, version })
  const directory = scaffold(app, 'visits')
  fs.writeFileSync(path.join(directory, 'imports.ts'), imports.map((name, index) => `import * as dependency${index} from '${name}'\nexport { dependency${index} }\n`).join(''))
  return { app, destination: path.join(root, 'export') }
}

test('host-provided packages are caret peers built against the installed version', (context) => {
  const { app, destination } = moduleApp(context, ['@tanstack/react-query', '@tanstack/react-table', 'zod'])
  const { manifest } = preparePackage(app, 'visits', { packageName: '@fixture/visits', version: '0.1.0', repository: '', access: 'public' }, destination)
  assert.equal(manifest.peerDependencies['@tanstack/react-query'], '^5.90.2')
  assert.equal(manifest.peerDependencies['@tanstack/react-table'], '^8.21.3')
  assert.equal(manifest.devDependencies['@tanstack/react-query'], '5.90.2')
  assert.equal(manifest.devDependencies['@tanstack/react-table'], '8.21.3')
  assert.deepEqual(manifest.dependencies, { zod: '4.1.12' })
  assert.equal(manifest.peerDependencies['@open-mercato/core'], '^0.9.0', 'framework peers accept compatible releases')
  assert.equal(manifest.devDependencies['@open-mercato/core'], '0.9.0')
})

test('a consumer install reuses its compatible host-provided package without a nested copy', (context) => {
  const { app, destination } = moduleApp(context, ['@tanstack/react-query'])
  preparePackage(app, 'visits', { packageName: '@fixture/visits', version: '0.1.0', repository: '', access: 'public' }, destination)
  const root = path.dirname(destination)
  const hostPackage = path.join(root, 'react-query-host')
  writeJson(path.join(hostPackage, 'package.json'), { name: '@tanstack/react-query', version: '5.90.3', main: 'index.js' })
  fs.writeFileSync(path.join(hostPackage, 'index.js'), 'module.exports = { source: "host" }\n')
  const consumer = path.join(root, 'consumer')
  writeJson(path.join(consumer, 'package.json'), {
    name: 'consumer',
    private: true,
    dependencies: {
      '@fixture/visits': `file:${path.relative(consumer, destination)}`,
      '@tanstack/react-query': `file:${path.relative(consumer, hostPackage)}`,
    },
  })
  run('npm', ['install', '--ignore-scripts', '--offline', '--legacy-peer-deps', '--no-audit', '--no-fund', '--cache', path.join(root, 'npm-cache')], consumer, { capture: true })
  assert.equal(JSON.parse(fs.readFileSync(path.join(consumer, 'node_modules/@tanstack/react-query/package.json'), 'utf8')).version, '5.90.3')
  assert.equal(fs.existsSync(path.join(consumer, 'node_modules/@fixture/visits/node_modules/@tanstack/react-query')), false)
})

test('a module without host-provided imports keeps plain runtime dependencies exact', (context) => {
  const { app, destination } = moduleApp(context, ['zod'])
  const { manifest } = preparePackage(app, 'visits', { packageName: '@fixture/visits', version: '0.1.0', repository: '', access: 'public' }, destination)
  assert.deepEqual(manifest.dependencies, { zod: '4.1.12' })
  assert.ok(!Object.keys(manifest.peerDependencies).some((name) => name.startsWith('@tanstack/')))
})
