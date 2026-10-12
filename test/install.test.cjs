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
if (true) enabledModules.push({ id: 'sales', from: '@open-mercato/core' })
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

test('canonical requirements distinguish package origins and include installation hints', (context) => {
  const fixture = appWithRequirements(
    context,
    [
      'marketing_consents',
      '@pkarw/marketing_consents@beta',
      'npm:@other/marketing_consents',
      'github:Open-Mercato/consents#main',
      'git@github.com:Other/consents.git',
      'npm:unscoped@1.0.0',
    ],
    `export const enabledModules = [
    { id: 'marketing_consents', from: '@pkarw/marketing_consents' },
    { id: 'unscoped', from: 'unscoped' },
  ]`,
  )
  fs.writeFileSync(
    path.join(fixture.directory, 'package.json'),
    JSON.stringify({
      dependencies: {
        '@pkarw/marketing_consents': 'github:open-mercato/consents#012345',
      },
    }),
  )
  const warnings = []
  const result = installFromInput(
    fixture,
    '@fixture/visits',
    { warn: (message) => warnings.push(message) },
    executor([]),
  )
  assert.deepEqual(result.missingRequirements, [
    'git@github.com:Other/consents.git',
    'npm:@other/marketing_consents',
  ])
  assert.match(
    warnings[0],
    /npx create-mercato-module install 'npm:@other\/marketing_consents'/,
  )
})

test('local locator preserves canonical requirements without matching another publisher', (context) => {
  const fixture = appWithRequirements(
    context,
    ['github:owner/consents', 'npm:@pkarw/marketing_consents', 'npm:@other/marketing_consents'],
    `export const enabledModules = [{ id: 'marketing_consents', from: '@app', locator: 'https://github.com/Owner/consents.git', packageName: '@pkarw/marketing_consents' }]`,
  )
  const result = installFromInput(
    fixture,
    '@fixture/visits',
    { warn() {} },
    executor([]),
  )
  assert.deepEqual(result.missingRequirements, [
    'npm:@other/marketing_consents',
  ])
})

test('GitHub collision fails before yarn changes package dependencies', (context) => {
  for (const registration of [
    `{ id: 'visits', from: '@another/visits' }`,
    `{ id: 'visits', from: '@app' }`,
    `{ id: 'visits', from: '@fixture/visits', locator: 'github:another/visits' }`,
  ]) {
    const fixture = appWithRequirements(
      context,
      [],
      `export const enabledModules = [${registration}]`,
    )
    const calls = []
    assert.throws(
      () =>
        installFromInput(
          fixture,
          'fixture-owner/visits-example',
          {},
          executor(calls),
        ),
      /same module ID.*No files were changed/,
    )
    assert.equal(
      calls.some((call) => call.command === 'yarn'),
      false,
    )
  }
})

test('GitHub locator refs install the same pinned source recommended by requirement hints', () => {
  const calls = []
  installFromInput(app, 'github:fixture-owner/visits-example#release-2', {}, executor(calls))
  assert.ok(calls.some(call => call.command === 'gh' && call.args[1]?.endsWith('/commits/release-2')))
  assert.throws(() => installFromInput(app, 'github:fixture-owner/visits-example#release-2', { ref: 'other' }, executor([])), /does not match --ref/)
})

test('repository metadata distinguishes dedicated packages from monorepo roots', (context) => {
  for (const directory of [undefined, 'packages/consents']) {
    const fixture = appWithRequirements(context, ['github:owner/consents'], `export const enabledModules = [{ id: 'marketing_consents', from: '@owner/consents' }]`)
    fs.writeFileSync(path.join(fixture.directory, 'package.json'), JSON.stringify({ dependencies: { '@owner/consents': '1.2.3' } }))
    const packageDirectory = path.join(fixture.directory, 'node_modules/@owner/consents')
    fs.mkdirSync(packageDirectory, { recursive: true })
    fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: '@owner/consents', repository: { url: 'git+https://github.com/Owner/consents.git', ...(directory ? { directory } : {}) } }))
    const result = installFromInput(fixture, '@fixture/visits', { warn() {} }, executor([]))
    assert.deepEqual(result.missingRequirements, directory ? ['github:owner/consents'] : undefined)
  }
})

test('GitHub installation refuses unregistered local module directories', (context) => {
  const fixture = appWithRequirements(context, [], 'export const enabledModules = []')
  fs.mkdirSync(path.join(fixture.directory, 'src/modules/visits'), { recursive: true })
  const calls = []
  assert.throws(() => installFromInput(fixture, 'fixture-owner/visits-example', {}, executor(calls)), /collide with this local module/)
  assert.equal(calls.some(call => call.command === 'yarn'), false)
})

test('all canonical GitHub installation forms resolve the same repository and selected ref', () => {
  for (const input of [
    'git+ssh://git@github.com/fixture-owner/visits-example.git#release-2',
    'http://github.com/fixture-owner/visits-example.git@release-2',
    'github.com/fixture-owner/visits-example#release-2',
  ]) {
    const calls = []
    const result = installFromInput(app, input, {}, executor(calls))
    assert.equal(result.repository, 'fixture-owner/visits-example')
    assert.ok(calls.some(call => call.args[1] === 'repos/fixture-owner/visits-example/commits/release-2'))
  }
  const result = installFromInput(app, 'github:visits-example', {}, executor([]))
  assert.equal(result.repository, 'fixture-owner/visits-example')
})

test('package metadata locator falls back only for dedicated packages and preserves npm publisher', (context) => {
  for (const directory of [undefined, 'packages/consents']) {
    const fixture = appWithRequirements(context, ['github:owner/consents', 'npm:@other/consents'], `export const enabledModules = [{ id: 'consents', from: '@owner/consents' }]`)
    const packageDirectory = path.join(fixture.directory, 'node_modules/@owner/consents')
    fs.mkdirSync(path.join(packageDirectory, 'src/modules/consents'), { recursive: true })
    fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: '@owner/consents', ...(directory ? { repository: { url: 'https://github.com/owner/monorepo', directory } } : {}) }))
    fs.writeFileSync(path.join(packageDirectory, 'src/modules/consents/index.ts'), `export const metadata = { locator: 'github:owner/consents' }`)
    const result = installFromInput(fixture, '@fixture/visits', { warn() {} }, executor([]))
    assert.deepEqual(result.missingRequirements, directory ? ['github:owner/consents', 'npm:@other/consents'] : ['npm:@other/consents'])
  }
})

test('configured local locator overrides stale authored metadata origin', (context) => {
  const fixture = appWithRequirements(context, ['github:owner/current', 'github:owner/stale'], `export const enabledModules = [{ id: 'consents', from: '@app', locator: 'github:owner/current' }]`)
  const moduleDirectory = path.join(fixture.directory, 'src/modules/consents')
  fs.mkdirSync(moduleDirectory, { recursive: true })
  fs.writeFileSync(path.join(moduleDirectory, 'index.ts'), `export const metadata = { locator: 'github:owner/stale' }`)
  const result = installFromInput(fixture, '@fixture/visits', { warn() {} }, executor([]))
  assert.deepEqual(result.missingRequirements, ['github:owner/stale'])
})

test('compiled package metadata and requirements use dist module indexes', (context) => {
  const fixture = appWithRequirements(context, ['github:owner/consents'], `export const enabledModules = [{ id: 'consents', from: '@owner/consents' }]`)
  const requestedPackage = path.join(fixture.directory, 'node_modules/@fixture/visits')
  fs.mkdirSync(path.join(requestedPackage, 'dist/modules/visits'), { recursive: true })
  fs.renameSync(path.join(requestedPackage, 'src/modules/visits/index.ts'), path.join(requestedPackage, 'dist/modules/visits/index.js'))
  fs.rmSync(path.join(requestedPackage, 'src'), { recursive: true })
  const packageDirectory = path.join(fixture.directory, 'node_modules/@owner/consents')
  fs.mkdirSync(path.join(packageDirectory, 'dist/modules/consents'), { recursive: true })
  fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: '@owner/consents' }))
  fs.writeFileSync(path.join(packageDirectory, 'dist/modules/consents/index.js'), `export const metadata = { locator: 'github:owner/consents' }`)
  const result = installFromInput(fixture, '@fixture/visits', { warn() {} }, executor([]))
  assert.equal(result.missingRequirements, undefined)
})

test('hoisted packages resolve requirements and origin despite package exports hiding the manifest', (context) => {
  const fixture = appWithRequirements(context, ['github:owner/consents', 'catalog'], `export const enabledModules = [{ id: 'consents', from: '@owner/consents' }]`)
  const appDirectory = path.join(fixture.directory, 'apps/store')
  fs.mkdirSync(appDirectory, { recursive: true })
  fs.renameSync(path.join(fixture.directory, 'src'), path.join(appDirectory, 'src'))
  fs.writeFileSync(path.join(appDirectory, 'package.json'), '{}')
  const packageDirectory = path.join(fixture.directory, 'node_modules/@owner/consents')
  fs.mkdirSync(packageDirectory, { recursive: true })
  fs.writeFileSync(path.join(packageDirectory, 'package.json'), JSON.stringify({ name: '@owner/consents', exports: { '.': './index.js' }, repository: 'https://github.com/owner/consents' }))
  fs.writeFileSync(path.join(packageDirectory, 'index.js'), 'module.exports = {}')
  const result = installFromInput({ ...fixture, directory: appDirectory }, '@fixture/visits', { warn() {} }, executor([]))
  assert.deepEqual(result.missingRequirements, ['catalog'])
})

test('conditional registration observes literal and environment conditions and skips unsupported branches', (context) => {
  const previous = process.env.MERCATO_TEST_CONSENTS
  context.after(() => {
    if (previous === undefined) delete process.env.MERCATO_TEST_CONSENTS
    else process.env.MERCATO_TEST_CONSENTS = previous
  })
  const entry = `{ id: 'consents', from: '@owner/consents' }`
  for (const [condition, enabled] of [
    ['if (false)', false],
    ['if (true)', true],
    ["if (process.env.MERCATO_TEST_CONSENTS === 'enabled')", true],
    ["if (process.env.MERCATO_TEST_CONSENTS !== 'enabled')", false],
    ['if (!process.env.MERCATO_TEST_CONSENTS)', false],
    ['if (unknownConfiguration())', false],
  ]) {
    process.env.MERCATO_TEST_CONSENTS = 'enabled'
    const fixture = appWithRequirements(context, ['npm:@owner/consents'], `export const enabledModules = []; ${condition} enabledModules.push(${entry})`)
    const result = installFromInput(fixture, '@fixture/visits', { warn() {} }, executor([]))
    assert.deepEqual(result.missingRequirements, enabled ? undefined : ['npm:@owner/consents'], condition)
  }
  delete process.env.MERCATO_TEST_CONSENTS
  for (const registration of [
    `if (process.env.MERCATO_TEST_CONSENTS) enabledModules.push(${entry})`,
    `false && enabledModules.push(${entry})`,
    `unknownConfiguration() && enabledModules.push(${entry})`,
    `function unused() { enabledModules.push(${entry}) }`,
  ]) {
    const fixture = appWithRequirements(context, ['npm:@owner/consents'], `export const enabledModules = []; ${registration}`)
    const result = installFromInput(fixture, '@fixture/visits', { warn() {} }, executor([]))
    assert.deepEqual(result.missingRequirements, ['npm:@owner/consents'], registration)
  }
})
