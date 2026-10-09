const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { scaffold } = require('../dist/scaffold.js')
const { loadConfig, saveConfig, saveDevelopment } = require('../dist/config.js')
const { checkAuthentication } = require('../dist/npm-auth.js')

const settings = { packageName: '@fixture/visits', version: '0.1.0', access: 'public', repository: '', auth: 'login' }

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-config-cli-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const app = { directory: path.join(root, 'app'), manifest: { name: 'fixture-app', private: true, dependencies: { '@open-mercato/core': '0.9.0', '@open-mercato/shared': '0.9.0', '@open-mercato/ui': '0.9.0', react: '19.0.0' } } }
  fs.mkdirSync(path.join(app.directory, 'src/modules'), { recursive: true })
  fs.writeFileSync(path.join(app.directory, 'package.json'), JSON.stringify(app.manifest))
  fs.writeFileSync(path.join(app.directory, 'src/modules.ts'), 'export const enabledModules = []\n')
  for (const [name, version] of Object.entries(app.manifest.dependencies)) {
    const directory = path.join(app.directory, 'node_modules', name)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version }))
  }
  scaffold(app, 'visits')
  const binary = path.join(root, 'bin')
  fs.mkdirSync(binary)
  const actualNpm = fs.realpathSync(spawnSync('which', ['npm'], { encoding: 'utf8' }).stdout.trim())
  function npm(success) {
    fs.writeFileSync(path.join(binary, 'npm'), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'); if(process.argv[2]==='whoami'){console.log('fixture');process.exit(${success ? 0 : 1})} const result=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(actualNpm)},...process.argv.slice(2)],{stdio:'inherit'});process.exit(result.status ?? 1)\n`, { mode: 0o755 })
  }
  npm(true)
  const preload = path.join(root, 'interactive.cjs')
  fs.writeFileSync(preload, `Object.defineProperty(process.stdin,'isTTY',{value:true});require('node:readline/promises').createInterface=()=>({question:async(label)=>{console.log('PROMPT:'+label);return label.includes('Publish this module')?(process.env.FIXTURE_CONFIRMATION||'n'):''},close(){}})\n`)
  function cli(args, interactive = true) {
    const result = spawnSync(process.execPath, [...(interactive ? ['--require', preload] : []), path.resolve(__dirname, '../dist/cli.js'), ...args], { cwd: app.directory, encoding: 'utf8', env: { ...process.env, PATH: `${binary}${path.delimiter}${process.env.PATH}`, NPM_TOKEN: '', NODE_AUTH_TOKEN: '' } })
    return { ...result, output: `${result.stdout}\n${result.stderr}` }
  }
  return { root, app, npm, cli }
}

test('legacy metadata is read and migrated with only supported, non-secret fields', (context) => {
  const { app } = fixture(context)
  fs.writeFileSync(path.join(app.directory, 'mercato-modules.json'), JSON.stringify({ version: 1, modules: { visits: { ...settings, lastPublishedVersion: '0.1.0', npmToken: 'private-token', environment: { NPM_TOKEN: 'private-token' } } } }))
  assert.equal(loadConfig(app).modules.visits.lastPublishedVersion, '0.1.0')
  saveConfig(app, 'visits', { ...settings, version: '0.1.1', token: 'do-not-save', NODE_AUTH_TOKEN: 'do-not-save' }, false)
  const metadataFile = path.join(app.directory, '.mercato/module-tool.json')
  const contents = fs.readFileSync(metadataFile, 'utf8')
  assert.doesNotMatch(contents, /private-token|do-not-save|npmToken|NODE_AUTH_TOKEN|environment/)
  assert.equal(loadConfig(app).modules.visits.lastPublishedVersion, '0.1.0')
  assert.equal(loadConfig(app).modules.visits.version, '0.1.1')
  assert.equal(fs.statSync(metadataFile).mode & 0o777, 0o600)
})

test('development metadata and published version survive later preference updates', (context) => {
  const { app } = fixture(context)
  const development = { formatVersion: 1, repository: 'fixture/visits', packageName: settings.packageName, checkoutPath: '.mercato/module-repos/visits', sourcePath: '.mercato/module-repos/visits/src/modules/visits', backupPath: '.mercato/module-backups/visits-123', secret: 'do-not-save' }
  saveConfig(app, 'visits', settings, true)
  saveDevelopment(app, 'visits', development, settings)
  saveConfig(app, 'visits', { ...settings, version: '0.1.1' }, false)
  const saved = loadConfig(app).modules.visits
  assert.equal(saved.lastPublishedVersion, '0.1.0')
  assert.equal(saved.development.checkoutPath, development.checkoutPath)
  assert.equal(saved.development.secret, undefined)
  saveConfig(app, 'visits', { ...settings, version: '0.1.1' }, true)
  assert.equal(loadConfig(app).modules.visits.lastPublishedVersion, '0.1.1')
})

test('metadata refuses symlinked folders and files, including dangling links', (context) => {
  const { root, app } = fixture(context)
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  const metadataDirectory = path.join(app.directory, '.mercato')
  fs.symlinkSync(outside, metadataDirectory)
  assert.throws(() => loadConfig(app), /real directory/)
  assert.throws(() => saveConfig(app, 'visits', settings, false), /real directory/)
  assert.deepEqual(fs.readdirSync(outside), [])
  fs.unlinkSync(metadataDirectory)
  fs.mkdirSync(metadataDirectory)
  fs.symlinkSync(path.join(outside, 'missing.json'), path.join(metadataDirectory, 'module-tool.json'))
  assert.throws(() => saveConfig(app, 'visits', settings, false), /symlink/)
  fs.unlinkSync(path.join(metadataDirectory, 'module-tool.json'))
  fs.symlinkSync(path.join(outside, 'missing-legacy.json'), path.join(app.directory, 'mercato-modules.json'))
  assert.throws(() => loadConfig(app), /symlink/)
})

test('authentication checks npm and selected GitHub before any package work', (context) => {
  const { app, npm, cli } = fixture(context)
  npm(false)
  const result = cli(['publish', 'visits', '--auth', 'login'])
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /npm login/)
  assert.doesNotMatch(result.output, /PROMPT:|Archive:/)
  assert.ok(!fs.existsSync(path.join(app.directory, '.mercato/module-publish')))
  const calls = []
  assert.throws(() => checkAuthentication(app.directory, { ...settings, repository: 'fixture/visits' }, (command, args) => {
    calls.push([command, ...args])
    return { status: command === 'gh' ? 1 : 0, stdout: 'fixture', stderr: '' }
  }), /gh auth login/)
  assert.deepEqual(calls, [['npm', 'whoami', '--@fixture:registry=https://registry.npmjs.org/'], ['gh', 'auth', 'status']])
})

test('repeat publication uses saved settings, auto-bumps version and only asks for confirmation', (context) => {
  const { app, cli } = fixture(context)
  saveConfig(app, 'visits', settings, true)
  const result = cli(['publish', 'visits'])
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /@fixture\/visits@0\.1\.1/)
  assert.equal((result.output.match(/PROMPT:/g) || []).length, 1)
  assert.match(result.output, /PROMPT:.*Publish this module/s)
  assert.equal(loadConfig(app).modules.visits.lastPublishedVersion, '0.1.0')
})

test('explicit settings are not prompted again and configure intentionally opens saved fields', (context) => {
  const { app, cli } = fixture(context)
  const supplied = cli(['publish', 'visits', '--package', settings.packageName, '--version', settings.version, '--repo', '-', '--access', 'public', '--auth', 'login'])
  assert.equal(supplied.status, 0, supplied.output)
  assert.equal((supplied.output.match(/PROMPT:/g) || []).length, 1)
  saveConfig(app, 'visits', settings, true)
  const configured = cli(['publish', 'visits', '--configure'])
  assert.equal(configured.status, 0, configured.output)
  assert.equal((configured.output.match(/PROMPT:/g) || []).length, 5)
  assert.match(configured.output, /📦 npm package|🔖 Version|🐙 Dedicated GitHub|🔐 Access/)
})

test('dry-run skips authentication even when npm login is unavailable', (context) => {
  const { app, npm, cli } = fixture(context)
  npm(false)
  const result = cli(['publish', 'visits', '--package', settings.packageName, '--auth', 'login', '--dry-run'])
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /Dry run complete/)
  assert.ok(fs.existsSync(path.join(app.directory, '.mercato/module-publish')))
  assert.ok(!fs.existsSync(path.join(app.directory, '.mercato/module-tool.json')))
})

test('publication needs the package name retyped interactively and explicit approval options otherwise', (context) => {
  const { app, cli } = fixture(context)
  const arguments_ = ['publish', 'visits', '--package', settings.packageName, '--version', settings.version, '--repo', '-', '--auth', 'login']
  const declined = cli(arguments_)
  assert.equal(declined.status, 0, declined.output)
  assert.match(declined.output, /PROMPT:.*Type the package name \(@fixture\/visits\) to confirm/s)
  assert.match(declined.output, /Publication canceled/)
  process.env.FIXTURE_CONFIRMATION = 'y'
  context.after(() => { delete process.env.FIXTURE_CONFIRMATION })
  const shortcut = cli(arguments_)
  assert.equal(shortcut.status, 0, shortcut.output)
  assert.match(shortcut.output, /Publication canceled/, 'y/yes must not approve a publication')
  delete process.env.FIXTURE_CONFIRMATION
  const unattended = cli(arguments_, false)
  assert.equal(unattended.status, 1, unattended.output)
  assert.match(unattended.output, /Nothing was published.*--yes/s)
  assert.doesNotMatch(unattended.output, /Submitted/)
  assert.equal(loadConfig(app).modules.visits, undefined)
})
