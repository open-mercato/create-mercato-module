const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { resolveAuth, createNpmRunner } = require('../dist/npm-auth.js')
const { createPublishWorkflow } = require('../dist/workflow.js')

test('authentication chooses login, environment token or GitHub OIDC without persisting credentials', () => {
  assert.equal(resolveAuth('auto', {}).mode, 'login')
  assert.equal(resolveAuth('auto', { NPM_TOKEN: 'test-token' }).mode, 'token')
  assert.equal(resolveAuth('auto', { NODE_AUTH_TOKEN: 'test-token' }).mode, 'token')
  const oidc = { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-secret' }
  assert.equal(resolveAuth('auto', oidc).mode, 'trusted')
  assert.equal(resolveAuth('trusted', { ...oidc, NPM_TOKEN: 'unused-token' }).token, undefined)
  assert.throws(() => resolveAuth('token', {}), /NPM_TOKEN or NODE_AUTH_TOKEN/)
  assert.throws(() => resolveAuth('trusted', {}), /id-token: write/)
})

test('token is passed only through child environment; temporary config is removed on cleanup', () => {
  const secret = `npm_${'t'.repeat(40)}`
  let config
  const runner = createNpmRunner('token', (command, args, cwd, options) => {
    assert.equal(command, 'npm')
    assert.ok(!args.some((value) => value.includes(secret)))
    config = options.env.npm_config_userconfig
    assert.equal(options.env.MERCATO_NPM_AUTH_TOKEN, secret)
    assert.equal(options.env.NPM_TOKEN, undefined)
    const contents = fs.readFileSync(config, 'utf8')
    assert.ok(!contents.includes(secret))
    assert.match(contents, /\$\{MERCATO_NPM_AUTH_TOKEN\}/)
    assert.equal(fs.statSync(config).mode & 0o777, 0o600)
    return { status: 0, stdout: 'fixture', stderr: '' }
  }, { NPM_TOKEN: secret })
  try { runner.execute('npm', ['whoami'], '/tmp', { capture: true }) } finally { runner.close() }
  assert.ok(!fs.existsSync(config))
})

test('trusted runner isolates login config, discards environment tokens, and leaves OIDC available', () => {
  const runner = createNpmRunner('trusted', (command, args, cwd, options) => {
    assert.equal(options.env.NPM_TOKEN, undefined)
    assert.equal(options.env.NODE_AUTH_TOKEN, undefined)
    assert.equal(options.env.MERCATO_NPM_AUTH_TOKEN, undefined)
    assert.equal(options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'oidc')
    assert.equal(fs.readFileSync(options.env.npm_config_userconfig, 'utf8'), '')
    return { status: 0, stdout: '', stderr: '' }
  }, { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc', NPM_TOKEN: 'discard', NODE_AUTH_TOKEN: 'discard' })
  try { runner.execute('npm', ['publish', 'module.tgz'], '/tmp') } finally { runner.close() }
})

test('generated trusted publishing workflow separates private dependency reads from OIDC publish', () => {
  const workflow = createPublishWorkflow('restricted')
  assert.match(workflow, /id-token: write/)
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets.NPM_READ_TOKEN \}\}/)
  assert.match(workflow, /npm publish --access restricted --tag "\$TAG" --ignore-scripts/)
  assert.doesNotMatch(workflow, /--provenance|secrets\.NPM_TOKEN/)
})

test('token and trusted npm commands run outside app project auth configuration', () => {
  const environment = { NPM_TOKEN: 'fixture-token' }
  const calls = []
  const runner = createNpmRunner('token', (command, args, cwd, options) => {
    calls.push({ command, cwd })
    if (command === 'npm') assert.equal(cwd, require('node:path').dirname(options.env.npm_config_userconfig))
    return { status: 0, stdout: '', stderr: '' }
  }, environment)
  try {
    runner.execute('npm', ['whoami'], '/app-with-project-npmrc')
    runner.execute('npm', ['publish', '/absolute/module.tgz'], '/app-with-project-npmrc')
    runner.execute('gh', ['auth', 'status'], '/app-with-project-npmrc')
  } finally { runner.close() }
  assert.notEqual(calls[0].cwd, '/app-with-project-npmrc')
  assert.equal(calls[2].cwd, '/app-with-project-npmrc')
})
