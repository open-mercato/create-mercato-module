const { test } = require('node:test')
const assert = require('node:assert/strict')
const { inspectRepository, publicationRisks } = require('../dist/publish.js')
const { createNpmRunner, resolveRegistry } = require('../dist/npm-auth.js')
const { createPublishWorkflow } = require('../dist/workflow.js')

const settings = { packageName: '@fixture/visits', version: '0.1.0', access: 'restricted', repository: 'fixture/visits', auth: 'login' }
const head = 'a'.repeat(40)

function github(responses) {
  return (command, args) => {
    assert.equal(command, 'gh')
    return responses[args[1]] || { status: 1, stdout: '', stderr: 'connection refused' }
  }
}

test('repository inspection reports visibility, branch and latest commit, and never guesses on errors', () => {
  const details = { status: 0, stdout: JSON.stringify({ private: false, default_branch: 'main' }), stderr: '' }
  const commit = (message) => ({ status: 0, stdout: `${JSON.stringify([head, message])}\n`, stderr: '' })
  const inspect = (responses) => inspectRepository('fixture/visits', '/tmp', github(responses))
  assert.deepEqual(inspect({ 'repos/fixture/visits': { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } }), { state: 'missing' })
  assert.deepEqual(inspect({ 'repos/fixture/visits': details, 'repos/fixture/visits/commits/main': commit('Release @fixture/visits@0.1.0\n\nMercato-Source: app') }), { state: 'exists', private: false, defaultBranch: 'main', head, appRelease: true })
  for (const message of ['Merge pull request #1', 'Release @fixture/visits@0.1.0', 'Release @fixture/visits@0.1.0\n\nMercato-Source: repository', 'Not Mercato-Source: app'])
    assert.equal(inspect({ 'repos/fixture/visits': details, 'repos/fixture/visits/commits/main': commit(message) }).appRelease, false, message)
  assert.deepEqual(inspect({ 'repos/fixture/visits': details, 'repos/fixture/visits/commits/main': { status: 1, stdout: '', stderr: 'Git Repository is empty. (HTTP 409)' } }), { state: 'exists', private: false, defaultBranch: 'main' })
  assert.throws(() => inspect({}), /nothing was published/)
  assert.throws(() => inspect({ 'repos/fixture/visits': details }), /nothing was published/)
  assert.throws(() => inspect({ 'repos/fixture/visits': details, 'repos/fixture/visits/commits/main': { status: 0, stdout: 'null', stderr: '' } }), /unreadable latest commit/)
  assert.throws(() => inspect({ 'repos/fixture/visits': { status: 0, stdout: '{}', stderr: '' } }), /incomplete/)
})

test('publication risks need approval for public source, unreleased repository commits, branches and install scripts', () => {
  const prepared = { manifest: {} }
  const linked = { ...prepared, linkedCheckout: '/checkout', linkedBranch: 'main' }
  const repository = { state: 'exists', private: true, defaultBranch: 'main', head, appRelease: true }
  const flags = (...args) => publicationRisks(...args).map((risk) => risk.flag)
  assert.deepEqual(flags(prepared, settings, repository), [])
  assert.deepEqual(flags(prepared, settings, { ...repository, private: false }), ['allow-public-repo'])
  assert.deepEqual(flags(prepared, { ...settings, access: 'public' }, { ...repository, private: false }), [])
  assert.deepEqual(flags(prepared, settings, { ...repository, appRelease: false }), ['overwrite-repo'])
  assert.deepEqual(flags(prepared, settings, { state: 'exists', private: true, defaultBranch: 'main' }), [], 'an empty repository has nothing to overwrite')
  assert.deepEqual(flags(prepared, settings, { state: 'missing' }), [])
  assert.deepEqual(flags(prepared, settings, undefined), [])
  assert.deepEqual(flags(linked, settings, { ...repository, appRelease: false }), [], 'a linked checkout is the source and is never overwritten')
  assert.deepEqual(flags({ ...linked, linkedBranch: 'feature' }, settings, repository), ['allow-branch'])
  assert.deepEqual(flags({ ...linked, installScripts: ['postinstall'] }, settings, repository), ['allow-install-scripts'])
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
  assert.doesNotMatch(workflow, /npm install --ignore-scripts/, 'an unlocked install of every dependency must not precede publication')
  assert.match(workflow, /typescript@\$\(node -p/)
  assert.match(workflow, /if: github\.ref_type == 'tag' \|\| github\.ref_name == github\.event\.repository\.default_branch/)
})

test('a test registry is accepted only on this machine and receives its own token line', () => {
  assert.equal(resolveRegistry({}), 'https://registry.npmjs.org/')
  assert.equal(resolveRegistry({ MERCATO_NPM_REGISTRY: 'http://127.0.0.1:4874' }), 'http://127.0.0.1:4874/')
  for (const value of ['https://registry.example.com/', 'http://127.0.0.1.example.com/', 'http://user:pass@127.0.0.1:4874/', 'http://localhost:4874/?x=1', 'file:///tmp/registry', 'not a url'])
    assert.throws(() => resolveRegistry({ MERCATO_NPM_REGISTRY: value }), /only for a local test registry/, value)
  const calls = []
  const runner = createNpmRunner('token', (command, args, cwd, options) => { calls.push({ args, config: require('node:fs').readFileSync(options.env.npm_config_userconfig, 'utf8'), env: options.env }); return { status: 0, stdout: '', stderr: '' } }, { NPM_TOKEN: 'fixture-token', MERCATO_NPM_REGISTRY: 'http://127.0.0.1:4874/' }, '@fixture/visits')
  try { runner.execute('npm', ['publish'], '/tmp') } finally { runner.close() }
  assert.equal(calls[0].config, '//127.0.0.1:4874/:_authToken=${MERCATO_NPM_AUTH_TOKEN}\n')
  assert.equal(calls[0].env.npm_config_registry, 'http://127.0.0.1:4874/')
  assert.deepEqual(calls[0].args, ['publish', '--@fixture:registry=http://127.0.0.1:4874/'])
})
