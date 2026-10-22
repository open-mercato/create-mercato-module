const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { satisfiesPeer, frameworkPeerWarning } = require('../dist/framework-peers.js')
const { installFromInput } = require('../dist/install.js')

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
