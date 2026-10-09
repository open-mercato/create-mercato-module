const { test } = require('node:test')
const assert = require('node:assert/strict')
const { run } = require('../dist/common.js')

test('captured command failure includes useful diagnostics instead of hiding them', () => {
  assert.throws(() => run(process.execPath, ['-e', "process.stderr.write('EINVALIDPACK Missing package version\\n');process.exit(2)"], process.cwd(), { capture: true }), error => {
    assert.match(error.message, /failed \(exit 2\)/)
    assert.match(error.message, /EINVALIDPACK Missing package version/)
    assert.match(error.message, /Fix this error and retry/)
    return true
  })
  assert.throws(() => run(process.execPath, ['-e', "console.log('stdout-only diagnostic');process.exit(1)"], process.cwd(), { capture: true }), /stdout-only diagnostic/)
})

test('captured diagnostics redact npm, GitHub, Bearer, Basic and URL credentials', () => {
  const secrets = [`npm_${'n'.repeat(40)}`, `github_pat_${'p'.repeat(40)}`, `ghp_${'g'.repeat(40)}`, 'bearer-credential', 'base64credential=', 'url-user:url-password', 'hidden-api-key', 'json-secret']
  const diagnostic = `Registry error;\n${secrets[0]} ${secrets[1]} ${secrets[2]}\nAuthorization: Bearer ${secrets[3]}\nBasic ${secrets[4]}\nhttps://${secrets[5]}@registry.example.invalid/package\napi_key=${secrets[6]}\n{"secret":"${secrets[7]}"}\nAction: check package permissions`
  assert.throws(() => run(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(diagnostic)});process.exit(1)`], process.cwd(), { capture: true }), error => {
    for (const secret of secrets) assert.ok(!error.message.includes(secret), `must not expose ${secret.slice(0, 3)}…`)
    assert.match(error.message, /\[REDACTED\]/)
    assert.match(error.message, /Action: check package permissions/)
    return true
  })
})

test('environment token values are redacted even without a recognizable token prefix', () => {
  const secret = 'fixture-session-opaque-value'
  const previous = process.env.MERCATO_TEST_TOKEN
  process.env.MERCATO_TEST_TOKEN = secret
  try {
    assert.throws(() => run(process.execPath, ['-e', "console.error('session value: '+process.env.MERCATO_TEST_TOKEN);process.exit(1)"], process.cwd(), { capture: true }), error => {
      assert.ok(!error.message.includes(secret))
      assert.match(error.message, /session value: \[REDACTED\]/)
      return true
    })
  } finally {
    if (previous === undefined) delete process.env.MERCATO_TEST_TOKEN
    else process.env.MERCATO_TEST_TOKEN = previous
  }
  assert.throws(() => run(process.execPath, ['-e', "console.error('child value: '+process.env.CUSTOM_ACCESS_TOKEN);process.exit(1)"], process.cwd(), { capture: true, env: { CUSTOM_ACCESS_TOKEN: secret } }), error => {
    assert.ok(!error.message.includes(secret))
    assert.match(error.message, /child value: \[REDACTED\]/)
    return true
  })
})

test('diagnostics are bounded after redaction and preserve the actionable tail', () => {
  const diagnostic = `${'noisy output\n'.repeat(1000)}\u001b[31mFinal error: invalid export map\u001b[0m`
  assert.throws(() => run(process.execPath, ['-e', `console.error(${JSON.stringify(diagnostic)});process.exit(1)`], process.cwd(), { capture: true }), error => {
    assert.ok(error.message.length < 3300)
    assert.match(error.message, /Final error: invalid export map/)
    assert.ok(!error.message.includes('\u001b'))
    return true
  })
})

test('allowFailure retains command results for callers that handle expected failures', () => {
  const result = run(process.execPath, ['-e', "console.error('expected missing package');process.exit(3)"], process.cwd(), { capture: true, allowFailure: true })
  assert.equal(result.status, 3)
  assert.match(result.stderr, /expected missing package/)
})
