const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { validateMutablePaths, repositoryFingerprint, assertNoCredentials } = require('../dist/repository-safety.js')

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-repo-safety-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const checkout = path.join(root, 'repository')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(checkout)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'sentinel'), 'untouched')
  return { root, checkout, outside }
}

function write(checkout, relative, contents = 'fixture') {
  const file = path.join(checkout, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

test('release paths reject traversal, absolute paths and invalid separators before any writes', (context) => {
  const { checkout, outside } = fixture(context)
  for (const relative of ['../outside/sentinel', '/tmp/sentinel', 'src/../../outside/sentinel', 'C:/outside/sentinel', 'src\\modules', 'src//index.ts', '.', '']) {
    assert.throws(() => validateMutablePaths(checkout, ['new/file.ts', relative]), /Unsafe repository release path/)
  }
  assert.deepEqual(fs.readdirSync(checkout), [])
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'untouched')
})

test('release paths reject symlink ancestry and final symlinks, including dangling ones', (context) => {
  const { checkout, outside } = fixture(context)
  fs.symlinkSync(outside, path.join(checkout, '.github'))
  assert.throws(() => validateMutablePaths(checkout, ['src', '.github/workflows/publish.yml']), /symlink/)
  assert.ok(!fs.existsSync(path.join(checkout, 'src')))
  assert.deepEqual(fs.readdirSync(outside), ['sentinel'])
  fs.unlinkSync(path.join(checkout, '.github'))
  fs.symlinkSync(path.join(outside, 'missing.json'), path.join(checkout, 'package.json'))
  assert.throws(() => validateMutablePaths(checkout, ['package.json']), /symlink/)
  fs.unlinkSync(path.join(checkout, 'package.json'))
  write(checkout, '.github/workflows', 'file instead of directory')
  assert.throws(() => validateMutablePaths(checkout, ['.github/workflows/publish.yml']), /parent.*not a directory/)
})

test('release paths accept regular owned directories, files and missing output ancestors', (context) => {
  const { checkout } = fixture(context)
  write(checkout, 'src/modules/visits/index.ts')
  write(checkout, 'package.json', '{}')
  assert.doesNotThrow(() => validateMutablePaths(checkout, ['src', 'src/modules/visits/index.ts', 'package.json', '.github/workflows/publish.yml']))
  assert.deepEqual(fs.readdirSync(checkout).sort(), ['package.json', 'src'])
})

test('repository fingerprint detects source, tests, metadata, docs, deletion and mode-independent content changes', (context) => {
  const { checkout } = fixture(context)
  write(checkout, 'src/modules/visits/index.ts', 'export const value = 1')
  write(checkout, 'package.json', '{"version":"0.1.0"}')
  const original = repositoryFingerprint(checkout, 'visits')
  assert.match(original, /^[a-f0-9]{64}$/)
  assert.equal(repositoryFingerprint(checkout, 'visits'), original)
  for (const relative of ['src/modules/visits/__tests__/index.test.ts', 'src/modules/visits/__mocks__/index.ts', 'README.md', 'LICENSE', 'build.cjs', '.github/workflows/publish.yml', '.gitignore', 'src/index.ts']) {
    write(checkout, relative, 'new contents')
    assert.notEqual(repositoryFingerprint(checkout, 'visits'), original, relative)
    fs.unlinkSync(path.join(checkout, relative))
  }
  const beforeDelete = repositoryFingerprint(checkout, 'visits')
  fs.unlinkSync(path.join(checkout, 'src/modules/visits/index.ts'))
  assert.notEqual(repositoryFingerprint(checkout, 'visits'), beforeDelete)
  write(checkout, 'src/modules/visits/index.ts', 'export const value = 1')
  const beforeIgnored = repositoryFingerprint(checkout, 'visits')
  write(checkout, 'src/modules/visits/node_modules/ignored.ts')
  write(checkout, 'src/modules/visits/.git/ignored')
  write(checkout, 'dist/modules/visits/index.js')
  assert.equal(repositoryFingerprint(checkout, 'visits'), beforeIgnored)
})

test('repository fingerprint refuses symlinks within source and manifest without following outside data', (context) => {
  const { checkout, outside } = fixture(context)
  write(checkout, 'src/modules/visits/index.ts')
  fs.symlinkSync(path.join(outside, 'sentinel'), path.join(checkout, 'src/modules/visits/private.ts'))
  assert.throws(() => repositoryFingerprint(checkout, 'visits'), /symlink/)
  fs.unlinkSync(path.join(checkout, 'src/modules/visits/private.ts'))
  fs.symlinkSync(path.join(outside, 'missing'), path.join(checkout, 'package.json'))
  assert.throws(() => repositoryFingerprint(checkout, 'visits'), /symlink/)
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'untouched')
})

test('credential scan covers package metadata and never displays the credential itself', () => {
  const secret = `npm_${'x'.repeat(40)}`
  assert.throws(() => assertNoCredentials('package.json', Buffer.from(JSON.stringify({ config: { token: secret } }))), error => {
    assert.match(error.message, /Possible credential in package.json/)
    assert.ok(!error.message.includes(secret))
    return true
  })
  assert.doesNotThrow(() => assertNoCredentials('package.json', '{"name":"@fixture/visits"}'))
})

test('repository fingerprint scans excluded tests and mocks before they can enter a Git release', (context) => {
  const { checkout } = fixture(context)
  write(checkout, 'src/modules/visits/index.ts')
  const secret = `npm_${'x'.repeat(40)}`
  for (const relative of ['src/modules/visits/__tests__/token.test.ts', 'src/modules/visits/__mocks__/token.ts', 'package.json']) {
    write(checkout, relative, secret)
    assert.throws(() => repositoryFingerprint(checkout, 'visits'), error => {
      assert.match(error.message, /Possible credential/)
      assert.ok(!error.message.includes(secret))
      return true
    })
    fs.unlinkSync(path.join(checkout, relative))
  }
  for (const filename of ['.env', '.npmrc', 'credentials.json', 'private.pem']) {
    const relative = `src/modules/visits/__tests__/${filename}`
    write(checkout, relative)
    assert.throws(() => repositoryFingerprint(checkout, 'visits'), /Remove credential file/)
    fs.unlinkSync(path.join(checkout, relative))
  }
})
