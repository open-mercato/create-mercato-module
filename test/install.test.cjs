const { test } = require('node:test')
const assert = require('node:assert/strict')
const { installFromInput } = require('../dist/install.js')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const commit = '0123456789abcdef0123456789abcdef01234567'

// A throwaway app with one installed module package that declares `requires`.
function appWithRequirements(context, requires, modules) {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'install-requirements-'),
  )
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const packageDirectory = path.join(directory, 'node_modules/@fixture/visits')
  fs.mkdirSync(path.join(packageDirectory, 'src/modules/visits'), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: '@fixture/visits',
      mercatoModule: { id: 'visits', formatVersion: 1 },
    }),
  )
  fs.writeFileSync(
    path.join(packageDirectory, 'src/modules/visits/index.ts'),
    `import type { ModuleInfo } from '@open-mercato/shared/modules/registry'\nexport const metadata: ModuleInfo = {\n  name: 'visits',\n  requires: ${JSON.stringify(requires)},\n}\n`,
  )
  fs.mkdirSync(path.join(directory, 'src'))
  if (modules !== undefined)
    fs.writeFileSync(path.join(directory, 'src/modules.ts'), modules)
  return { directory, manifest: {} }
}

const registeredModules = `export const enabledModules: ModuleEntry[] = [
  { id: 'auth', from: '@open-mercato/core' },
  { id: 'customers', from: '@open-mercato/core' },
]
if (process.env.WITH_SALES) enabledModules.push({ id: 'sales', from: '@open-mercato/core' })
`

function executor(calls, options = {}) {
  return (command, args, cwd) => {
    calls.push({ command, args, cwd })
    if (command === 'gh' && args[0] === 'auth')
      return { status: options.loggedOut ? 1 : 0, stdout: '', stderr: '' }
    if (command === 'gh' && args[1] === 'user')
      return { status: 0, stdout: JSON.stringify({ login: 'fixture-owner' }), stderr: '' }
    if (command === 'gh' && args[1]?.includes('/commits/')) {
      const ref = decodeURIComponent(args[1].split('/commits/')[1])
      return {
        status: 0,
        stdout: `${options.commits?.[ref] || commit}\n`,
        stderr: '',
      }
    }
    if (command === 'gh' && args[1]?.match(/^repos\/.+\/contents\/package\.json\?ref=/))
      return {
        status: 0,
        stdout: JSON.stringify({
          name: options.packageName || '@fixture/visits',
          version: '1.2.3',
          mercatoModule: { id: 'visits', formatVersion: 1 },
        }),
        stderr: '',
      }
    if (command === 'gh' && args[1]?.startsWith('repos/'))
      return { status: 0, stdout: JSON.stringify({ private: false, default_branch: 'main' }), stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
}

const app = { directory: '/fixture/app', manifest: {} }

test('npm locators delegate installation, registration and generation to Open Mercato', () => {
  for (const [input, specifier, packageName] of [
    ['@fixture/visits', '@fixture/visits', '@fixture/visits'],
    ['@fixture/visits@beta', '@fixture/visits@beta', '@fixture/visits'],
    ['npm:visits', 'visits', 'visits'],
    ['npm:visits@1.2.3', 'visits@1.2.3', 'visits'],
  ]) {
    const calls = []
    assert.deepEqual(
      installFromInput(
        app,
        input,
        { eject: true, moduleId: 'visits' },
        executor(calls),
      ),
      { packageName, specifier },
    )
    assert.deepEqual(calls, [
      {
        command: 'yarn',
        args: [
          'mercato',
          'module',
          'add',
          specifier,
          '--allow-third-party',
          '--module',
          'visits',
          '--eject',
        ],
        cwd: app.directory,
      },
    ])
  }
})

test('GitHub locators discover identity, install the repository and enable through Open Mercato', () => {
  for (const input of [
    'fixture-owner/visits-example',
    'visits-example',
    'https://github.com/fixture-owner/visits-example.git',
    'git@github.com:fixture-owner/visits-example.git',
    'ssh://git@github.com/fixture-owner/visits-example.git',
    'github:fixture-owner/visits-example',
  ]) {
    const calls = []
    assert.deepEqual(installFromInput(app, input, {}, executor(calls)), {
      commit,
      packageName: '@fixture/visits',
      repository: 'fixture-owner/visits-example',
      specifier: `@fixture/visits@github:fixture-owner/visits-example#${commit}`,
    })
    assert.deepEqual(calls.slice(-2), [
      {
        command: 'yarn',
        args: ['add', `@fixture/visits@github:fixture-owner/visits-example#${commit}`],
        cwd: app.directory,
      },
      {
        command: 'yarn',
        args: [
          'mercato',
          'module',
          'enable',
          '@fixture/visits',
          '--allow-third-party',
        ],
        cwd: app.directory,
      },
    ])
  }
})

test('GitHub --ref resolves once and pins a commit independent of the default head', () => {
  const calls = []
  const selectedCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const defaultCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  assert.deepEqual(
    installFromInput(
      app,
      'fixture-owner/visits-example',
      { ref: 'release/1.2.3' },
      executor(calls, {
        commits: { 'release/1.2.3': selectedCommit, main: defaultCommit },
      }),
    ),
    {
      commit: selectedCommit,
      packageName: '@fixture/visits',
      repository: 'fixture-owner/visits-example',
      specifier: `@fixture/visits@github:fixture-owner/visits-example#${selectedCommit}`,
    },
  )
  assert.ok(
    calls.some(
      ({ command, args }) =>
        command === 'gh' &&
        args[1] ===
          'repos/fixture-owner/visits-example/commits/release%2F1.2.3',
    ),
  )
  assert.equal(
    calls.some(({ args }) => args[1]?.includes('/commits/main')),
    false,
  )
  assert.ok(
    calls.some(({ args }) =>
      args[1]?.endsWith(`contents/package.json?ref=${selectedCommit}`),
    ),
  )
})

test('installation validates identities and command values before invoking Yarn', () => {
  const calls = []
  assert.throws(
    () =>
      installFromInput(
        app,
        '@fixture/visits',
        { expectedPackage: '@fixture/other' },
        executor(calls),
      ),
    /does not match --package/,
  )
  assert.throws(
    () =>
      installFromInput(
        app,
        'fixture-owner/visits-example',
        { moduleId: '../escape' },
        executor(calls),
      ),
    /snake_case/,
  )
  assert.throws(
    () =>
      installFromInput(
        app,
        '@fixture/visits',
        { ref: 'v1.2.3' },
        executor(calls),
      ),
    /only available for GitHub/,
  )
  assert.throws(
    () =>
      installFromInput(
        app,
        'fixture-owner/visits-example',
        { ref: '../unsafe ref' },
        executor(calls),
      ),
    /valid Git tag/,
  )
  assert.equal(calls.some((call) => call.command === 'yarn'), false)
})

test('GitHub installs warn about required modules before enabling', (context) => {
  const withRequirements = appWithRequirements(
    context,
    ['customers', 'sales', 'catalog', 'dictionaries', 'visits'],
    registeredModules,
  )
  const calls = []
  const warnings = []
  const result = installFromInput(
    withRequirements,
    'fixture-owner/visits-example',
    { warn: (message) => warnings.push({ message, calls: calls.length }) },
    executor(calls),
  )
  assert.deepEqual(result.missingRequirements, ['catalog', 'dictionaries'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].message, /@fixture\/visits requires modules this app has not enabled: catalog, dictionaries\./)
  assert.match(warnings[0].message, /src\/modules\.ts first/)
  // Printed after `yarn add` and before `yarn mercato module enable`.
  assert.deepEqual(calls[warnings[0].calls - 1].args.slice(0, 1), ['add'])
  assert.deepEqual(calls[warnings[0].calls].args.slice(0, 3), ['mercato', 'module', 'enable'])
})

test('installs stay silent when requirements are met or cannot be determined', (context) => {
  for (const [requires, modules] of [
    [['auth', 'customers', 'sales'], registeredModules],
    [[], registeredModules],
    [['catalog'], undefined],
    [['catalog'], 'export const enabledModules = loadModules()\n'],
  ]) {
    const fixture = appWithRequirements(context, requires, modules)
    const warnings = []
    for (const input of ['fixture-owner/visits-example', '@fixture/visits']) {
      const result = installFromInput(
        fixture,
        input,
        { warn: (message) => warnings.push(message) },
        executor([]),
      )
      assert.equal(result.missingRequirements, undefined)
    }
    assert.deepEqual(warnings, [])
  }
})

test('failed installs name the missing required modules and what was changed', (context) => {
  const fixture = appWithRequirements(context, ['catalog'], registeredModules)
  const failing = (step) => (command, args, cwd) => {
    if (command === 'yarn' && args.includes(step))
      throw new Error('yarn failed (exit 1). Fix the reported error and retry.')
    return executor([])(command, args, cwd)
  }
  assert.throws(
    () => installFromInput(fixture, '@fixture/visits', { warn() {} }, failing('add')),
    (error) =>
      /yarn failed \(exit 1\)/.test(error.message) &&
      /requires a module this app has not enabled: catalog\./.test(error.message),
  )
  assert.throws(
    () =>
      installFromInput(fixture, 'fixture-owner/visits-example', { warn() {} }, failing('enable')),
    (error) =>
      /yarn failed \(exit 1\)/.test(error.message) &&
      /@fixture\/visits was added to package\.json but is not enabled/.test(error.message) &&
      /not enabled: catalog\./.test(error.message),
  )
  // Without unmet requirements the original npm error is passed through.
  const satisfied = appWithRequirements(context, ['auth'], registeredModules)
  assert.throws(
    () => installFromInput(satisfied, '@fixture/visits', {}, failing('add')),
    { message: 'yarn failed (exit 1). Fix the reported error and retry.' },
  )
})

test('npm installs warn about required modules once the package is on disk', (context) => {
  const fixture = appWithRequirements(context, ['catalog'], registeredModules)
  const warnings = []
  const result = installFromInput(
    fixture,
    '@fixture/visits',
    { warn: (message) => warnings.push(message) },
    executor([]),
  )
  assert.deepEqual(result.missingRequirements, ['catalog'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /requires a module this app has not enabled: catalog\./)
})
