const { test } = require('node:test')
const assert = require('node:assert/strict')
const { installFromInput } = require('../dist/install.js')
const commit = '0123456789abcdef0123456789abcdef01234567'

function executor(calls, options = {}) {
  return (command, args, cwd) => {
    calls.push({ command, args, cwd })
    if (command === 'gh' && args[0] === 'auth')
      return { status: options.loggedOut ? 1 : 0, stdout: '', stderr: '' }
    if (command === 'gh' && args[1] === 'user')
      return { status: 0, stdout: JSON.stringify({ login: 'fixture-owner' }), stderr: '' }
    if (command === 'gh' && args[1]?.includes('/commits/'))
      return { status: 0, stdout: `${commit}\n`, stderr: '' }
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
  assert.equal(calls.some((call) => call.command === 'yarn'), false)
})
