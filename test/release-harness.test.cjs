const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

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
  const app = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mercato-yarn-fixture-'))
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

test('release CI keeps a pinned create-app leg next to the latest scaffold', () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/test.yml'), 'utf8')
  assert.match(workflow, /--create-app "\$CREATE_APP"/, 'release CI must pass the matrix scaffold')
  const scaffolds = [...workflow.matchAll(/- scaffold: (create-mercato-app@\S+)/g)].map((match) => match[1])
  assert.ok(scaffolds.some((scaffold) => /@\d+\.\d+\.\d+$/.test(scaffold)), 'one leg must pin an exact, coherent release')
  assert.ok(scaffolds.includes('create-mercato-app@latest'), 'one leg must follow what new users get')
  assert.ok(!scaffolds.some((scaffold) => scaffold.endsWith('@develop')))
})

test('local release checks install both lanes through create-mercato-module install', () => {
  const source = fs.readFileSync(path.join(__dirname, 'release-e2e/run.mts'), 'utf8')
  assert.doesNotMatch(source, /approve-fixture-age|approve-local-git|enable-github-module/, 'no harness shortcut around the user path')
  assert.match(source, /install-refused-by-age-gate/)
  assert.match(source, /\[toolBin, 'install', npmLocator, '--preapprove-package'\]/)
  assert.match(source, /\[toolBin, 'install', `\$\{options\.repository\}@\$\{options\.ref\}`, '--approve-git-repository'\]/)
})

test('local release checks publish their fixture without a warning', async (context) => {
  const { fixtureDescription, publishArguments } = await import('./release-e2e/local.mts')
  const { writeFixture, fixtureContract } = await import('./release-e2e/fixture.mts')
  const { writeJson } = require('../dist/common.js')
  const app = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mercato-release-warnings-'))
  context.after(() => fs.rmSync(app, { recursive: true, force: true }))
  const dependencies = { '@open-mercato/core': '0.9.0', '@open-mercato/shared': '0.9.0', '@open-mercato/ui': '0.9.0', '@mikro-orm/decorators': '7.0.0', '@mikro-orm/migrations': '7.0.0', react: '19.0.0' }
  writeJson(path.join(app, 'package.json'), { name: 'release-source-app', private: true, dependencies })
  for (const [name, version] of Object.entries(dependencies)) writeJson(path.join(app, 'node_modules', name, 'package.json'), { name, version })
  fs.mkdirSync(path.join(app, 'src/modules'), { recursive: true })
  fs.writeFileSync(path.join(app, 'src/modules.ts'), 'export const enabledModules = []\n')
  const cli = (args) => spawnSync(process.execPath, [path.resolve(__dirname, '../bin/cli.cjs'), ...args], { cwd: app, encoding: 'utf8', timeout: 60000, env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture' } })
  const init = cli(['init', fixtureContract.moduleId, '--description', fixtureDescription, '--no-generate'])
  assert.equal(init.status, 0, init.stderr)
  writeFixture(app, { extend: true })
  const dry = cli(['publish', fixtureContract.moduleId, ...publishArguments('0.0.1'), '--dry-run'])
  assert.equal(dry.status, 0, dry.stderr)
  assert.doesNotMatch(dry.stdout, /⚠️/, 'local.mts asserts that its first releases print no warning')
  const source = fs.readFileSync(path.join(__dirname, 'release-e2e/local.mts'), 'utf8')
  assert.match(source, /\[toolBin, 'init', fixtureContract\.moduleId, '--description', fixtureDescription\]/)
  assert.match(source, /\[toolBin, 'publish', fixtureContract\.moduleId, \.\.\.publishArguments\(version\), '--yes'\]/)
})

test('release fixture writer creates portable module source and refuses to replace existing source', async (context) => {
  const { writeFixture, fixtureContract } = await import('./release-e2e/fixture.mts')
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mercato-release-fixture-'))
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

test('release harness keeps its servers inside RELEASE_E2E_PORTS', async () => {
  const { freePort } = await import('./release-e2e/run.mts')
  const port = await freePort('51290-51299')
  assert.ok(port >= 51290 && port <= 51299)
  assert.ok((await freePort(undefined)) > 0)
  await assert.rejects(() => freePort('80-90'), /RELEASE_E2E_PORTS/)
  await assert.rejects(() => freePort('51299-51290'), /RELEASE_E2E_PORTS/)
})
