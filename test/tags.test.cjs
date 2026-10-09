const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { validateSettings } = require('../dist/package.js')
const { scaffold } = require('../dist/scaffold.js')
const { saveConfig, loadConfig } = require('../dist/config.js')
const { exportPackage, publish } = require('../dist/publish.js')
const { createPublishWorkflow } = require('../dist/workflow.js')

const base = { packageName: '@fixture/visits', version: '0.1.0', access: 'public', auth: 'login', repository: '' }
function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-tags-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const manifest = { name: 'fixture-app', private: true, dependencies: { '@open-mercato/core': '0.9.0', '@open-mercato/shared': '0.9.0', '@open-mercato/ui': '0.9.0', react: '19.0.0' } }
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest))
  fs.mkdirSync(path.join(directory, 'src/modules'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'src/modules.ts'), 'export const enabledModules = []\n')
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const target = path.join(directory, 'node_modules', name)
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name, version }))
  }
  const app = { directory, manifest }
  scaffold(app, 'visits')
  function cli(flags) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/cli.js'), 'publish', 'visits', '--package', base.packageName, '--dry-run', ...flags], { cwd: directory, encoding: 'utf8' })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    return result.stdout
  }
  return { app, cli }
}

test('npm tags accept named channels and reject version ranges and unsafe characters', () => {
  for (const tag of ['latest', 'next', 'beta', 'canary', 'release-2026', 'beta.1']) assert.doesNotThrow(() => validateSettings({ ...base, tag }))
  for (const tag of ['1.2.3', 'v1', 'v1.2.3', 'x', 'x.x', 'vx', '../next', 'next;echo', 'LATEST']) assert.throws(() => validateSettings({ ...base, tag }), /npm tag/)
})

test('CLI derives latest for stable versions, next for prereleases, and honors explicit channels', (context) => {
  const { cli } = fixture(context)
  assert.match(cli(['--version', '0.1.0']), /npm tag:\s+latest/)
  assert.match(cli(['--version', '0.2.0-beta.1']), /npm tag:\s+next/)
  assert.match(cli(['--version', '0.2.0-beta.1', '--tag', 'beta']), /npm tag:\s+beta/)
})

test('saved custom tags persist while default channels adapt to the chosen version', (context) => {
  const { app, cli } = fixture(context)
  saveConfig(app, 'visits', { ...base, tag: 'canary' }, true)
  assert.equal(loadConfig(app).modules.visits.tag, 'canary')
  assert.match(cli([]), /npm tag:\s+canary/)
  saveConfig(app, 'visits', { ...base, tag: 'latest' }, true)
  assert.match(cli(['--version', '0.2.0-beta.1']), /npm tag:\s+next/)
  saveConfig(app, 'visits', { ...base, version: '0.2.0-beta.1', tag: 'next' }, true)
  assert.match(cli(['--version', '0.2.0']), /npm tag:\s+latest/)
})

test('publication sends explicit npm channel for prereleases and custom tags', (context) => {
  const { app } = fixture(context)
  for (const settings of [{ ...base }, { ...base, version: '0.2.0-beta.1' }, { ...base, version: '0.2.0-beta.1', tag: 'beta' }]) {
    const prepared = exportPackage(app, 'visits', settings)
    let publication
    publish(prepared, settings, (command, args) => {
      if (command === 'npm' && args[0] === 'view') return { status: 1, stdout: '', stderr: 'E404' }
      if (command === 'npm' && args[0] === 'publish') publication = args
      return { status: 0, stdout: 'fixture', stderr: '' }
    })
    const tagOffset = publication.indexOf('--tag')
    if (!settings.version.includes('-') && !settings.tag) assert.equal(tagOffset, -1)
    else assert.equal(publication[tagOffset + 1], settings.tag || 'next')
  }
})

test('trusted workflow derives a safe channel before publishing a tagged prerelease', () => {
  const workflow = createPublishWorkflow('public')
  assert.match(workflow, /TAG=latest/)
  assert.match(workflow, /version\.includes\('-'\).*TAG=next/)
  assert.match(workflow, /npm publish --access public --tag "\$TAG" --ignore-scripts/)
})
