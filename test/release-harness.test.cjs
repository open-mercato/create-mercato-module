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

test('release harness disables Yarn package-age gates for nested Git package builds', async () => {
  const { gitPackageEnvironment } = await import('./release-e2e/run.mts')
  const original = { CI: '0', YARN_NPM_MINIMAL_AGE_GATE: '1d' }
  const environment = gitPackageEnvironment(original)
  assert.equal(environment.CI, '0')
  assert.equal(environment.YARN_NPM_MINIMAL_AGE_GATE, '0')
  assert.equal(original.YARN_NPM_MINIMAL_AGE_GATE, '1d')
})

test('fresh release fixtures use patched Yarn without changing app dependencies or approvals', async (context) => {
  const { pinFixtureYarn } = await import('./release-e2e/run.mts')
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-yarn-fixture-'))
  context.after(() => fs.rmSync(app, { recursive: true, force: true }))
  const manifest = {
    name: 'release-fixture',
    packageManager: 'yarn@4.17.1',
    dependencies: { '@open-mercato/core': '0.8.1-develop.7452.1.5e211edd51' },
    scripts: { generate: 'mercato generate' },
  }
  const config = 'approvedGitRepositories:\n  - https://github.com/open-mercato/*\n'
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(manifest))
  fs.writeFileSync(path.join(app, '.yarnrc.yml'), config)
  pinFixtureYarn(app)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')), {
    ...manifest,
    packageManager: 'yarn@4.18.1',
  })
  assert.equal(fs.readFileSync(path.join(app, '.yarnrc.yml'), 'utf8'), config)
  const pinned = fs.readFileSync(path.join(app, 'package.json'), 'utf8')
  pinFixtureYarn(app)
  assert.equal(fs.readFileSync(path.join(app, 'package.json'), 'utf8'), pinned)
})

test('real GitHub release checks pass the preflight commit through install', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'release-e2e/run.mts'),
    'utf8',
  )
  assert.match(
    source,
    /\[toolBin, 'install', `https:\/\/github\.com\/\$\{options\.repository\}\.git`, '--ref', githubCommit\]/,
  )
  assert.doesNotMatch(source, /github-default-commit/)
})

test('release harness recognizes required modules in generated registrations', async () => {
  const { hasEnabledModule } = await import('./release-e2e/run.mts')
  assert.equal(hasEnabledModule("export const enabledModules = [{ id: 'auth', from: '@open-mercato/core' }]", 'auth'), true)
  assert.equal(hasEnabledModule("export const enabledModules = [{ id: 'auth', from: '@open-mercato/core' }]", 'api_keys'), false)
  assert.throws(() => hasEnabledModule('', '../api_keys'), /module id/)
})

test('release CI pins a coherent create-app version instead of a moving tag', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/test.yml'), 'utf8')
  const createApp = workflow.match(/--create-app (create-mercato-app@\S+)/)?.[1]
  assert.ok(createApp, 'release CI must pass --create-app')
  assert.doesNotMatch(createApp, /@(develop|latest)$/)
})

test('release fixture writer creates portable module source and refuses to replace existing source', async (context) => {
  const { writeFixture, fixtureContract } = await import('./release-e2e/fixture.mts')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-release-fixture-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  writeFixture(directory)
  const moduleRoot = path.join(directory, 'src/modules', fixtureContract.moduleId)
  assert.match(fs.readFileSync(path.join(moduleRoot, 'data/entities.ts'), 'utf8'), /updatedAt: Date/)
  assert.match(fs.readFileSync(path.join(moduleRoot, 'api/status.ts'), 'utf8'), /\.\.\/lib\/fields/)
  const migration = fs.readFileSync(path.join(moduleRoot, `${fixtureContract.migration}.ts`), 'utf8')
  assert.match(migration, /extends Migration/)
  assert.match(migration, /create table "release_checks"/)
  for (const column of ['id', 'organization_id', 'tenant_id', 'status', 'updated_at']) {
    assert.ok(migration.includes(`"${column}"`), `Fixture migration must include ${column}`)
  }
  assert.match(migration, /drop table if exists "release_checks"/)
  assert.throws(() => writeFixture(directory), /already exists/)
})
