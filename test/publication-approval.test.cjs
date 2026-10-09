const { test } = require('node:test')
const assert = require('node:assert/strict')
const { inspectRepository, publicationRisks } = require('../dist/publish.js')
const { createNpmRunner } = require('../dist/npm-auth.js')
const { createPublishWorkflow } = require('../dist/workflow.js')

const settings = { packageName: '@fixture/visits', version: '0.1.0', access: 'restricted', repository: 'fixture/visits', auth: 'login' }
const head = 'a'.repeat(40)

function github(responses) {
  return (command, args) => {
    assert.equal(command, 'gh')
    return responses[args[1]] || { status: 1, stdout: '', stderr: 'connection refused' }
  }
}

test('repository inspection reports visibility and latest commit, and never guesses on errors', () => {
  const details = { status: 0, stdout: JSON.stringify({ private: false, default_branch: 'main' }), stderr: '' }
  assert.deepEqual(inspectRepository('fixture/visits', '/tmp', github({ 'repos/fixture/visits': { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } })), { state: 'missing' })
  assert.deepEqual(inspectRepository('fixture/visits', '/tmp', github({ 'repos/fixture/visits': details, 'repos/fixture/visits/commits/main': { status: 0, stdout: `${head}\n`, stderr: '' } })), { state: 'exists', private: false, head })
  assert.deepEqual(inspectRepository('fixture/visits', '/tmp', github({ 'repos/fixture/visits': details, 'repos/fixture/visits/commits/main': { status: 1, stdout: '', stderr: 'Git Repository is empty. (HTTP 409)' } })), { state: 'exists', private: false })
  assert.throws(() => inspectRepository('fixture/visits', '/tmp', github({})), /nothing was published/)
  assert.throws(() => inspectRepository('fixture/visits', '/tmp', github({ 'repos/fixture/visits': details })), /nothing was published/)
  assert.throws(() => inspectRepository('fixture/visits', '/tmp', github({ 'repos/fixture/visits': { status: 0, stdout: '{}', stderr: '' } })), /incomplete/)
})

test('publication risks need approval for public source, unreleased repository commits and install scripts', () => {
  const prepared = { manifest: {} }
  const flags = (...args) => publicationRisks(...args).map((risk) => risk.flag)
  assert.deepEqual(flags(prepared, settings, { state: 'exists', private: false, head }, head), ['allow-public-repo'])
  assert.deepEqual(flags(prepared, settings, { state: 'exists', private: true, head }, head), [])
  assert.deepEqual(flags(prepared, { ...settings, access: 'public' }, { state: 'exists', private: false, head }, head), [])
  assert.deepEqual(flags(prepared, settings, { state: 'exists', private: true, head }, 'b'.repeat(40)), ['overwrite-repo'])
  assert.deepEqual(flags(prepared, settings, { state: 'exists', private: true, head }), ['overwrite-repo'], 'an unknown last release is not proof that nothing changed')
  assert.deepEqual(flags(prepared, settings, { state: 'exists', private: true }), [])
  assert.deepEqual(flags(prepared, settings, { state: 'missing' }), [])
  assert.deepEqual(flags({ ...prepared, linkedCheckout: '/checkout', installScripts: ['postinstall'] }, settings, { state: 'exists', private: true, head }), ['allow-install-scripts'])
})

test('npm commands stay on the npm registry despite inherited and scoped registry settings', () => {
  const calls = []
  const runner = createNpmRunner('login', (command, args, cwd, options) => { calls.push({ args, env: options.env }); return { status: 0, stdout: '', stderr: '' } }, { NPM_CONFIG_REGISTRY: 'https://example.com/', npm_config_registry: 'https://example.org/' }, '@fixture_scope/visits')
  runner.execute('npm', ['publish'], '/tmp')
  runner.close()
  assert.deepEqual(calls[0].args, ['publish', '--@fixture_scope:registry=https://registry.npmjs.org/'])
  assert.deepEqual(Object.entries(calls[0].env).filter(([key]) => /registry/i.test(key)), [['npm_config_registry', 'https://registry.npmjs.org/']])
})

test('generated workflow pins actions to commits and limits manual runs to the default branch', () => {
  const workflow = createPublishWorkflow('public')
  assert.doesNotMatch(workflow, /uses: [^\n]+@v\d/)
  assert.match(workflow, /uses: actions\/checkout@[0-9a-f]{40} # v4/)
  assert.match(workflow, /if: github\.ref_type == 'tag' \|\| github\.ref_name == github\.event\.repository\.default_branch/)
})
