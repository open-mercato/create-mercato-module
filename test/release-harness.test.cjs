const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('release harness rejects ambiguous refs, credentials in repo URLs and unknown lanes before running commands', async () => {
  const { parseOptions } = await import('./release-e2e/run.mts')
  const base = ['--package', '@fixture/checks', '--version', '0.0.1', '--repo', 'fixture/checks']
  assert.deepEqual(parseOptions(base).lanes, ['npm', 'github'])
  assert.throws(() => parseOptions([...base, '--ref', '--force']), /Invalid option/)
  assert.throws(() => parseOptions([...base, '--lanes', 'npm,unknown']), /lanes/)
  assert.throws(() => parseOptions(['--package', '@fixture/checks', '--version', '0.0.1', '--repo', 'https://token@github.com/a/b']), /credentials/)
})

test('release harness redacts auth tokens and URL credentials from retained diagnostics', async () => {
  const { redact } = await import('./release-e2e/run.mts')
  const secret = 'fixture-secret-value'
  assert.equal(redact(`npm_abcdefghijklmnopqrstuvwxyz ${secret} https://name:password@example.com/path`, [secret]), '[REDACTED] [REDACTED] https://[REDACTED]@example.com/path')
})

test('release fixture writer creates portable module source and refuses to replace existing source', async (context) => {
  const { writeFixture, fixtureContract } = await import('./release-e2e/fixture.mts')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-release-fixture-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  writeFixture(directory)
  const moduleRoot = path.join(directory, 'src/modules', fixtureContract.moduleId)
  assert.match(fs.readFileSync(path.join(moduleRoot, 'data/entities.ts'), 'utf8'), /updatedAt: Date/)
  assert.match(fs.readFileSync(path.join(moduleRoot, 'api/status.ts'), 'utf8'), /\.\.\/lib\/fields/)
  assert.throws(() => writeFixture(directory), /already exists/)
})
