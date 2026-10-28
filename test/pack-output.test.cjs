const { test } = require('node:test')
const assert = require('node:assert/strict')
const { packEntries } = require('../dist/publish.js')

const entry = { filename: 'x-visits-0.1.0.tgz', integrity: 'sha512-fixture', files: [{ path: 'package.json' }] }

test('npm pack output is read from npm 11 arrays and npm 12 objects keyed by package name', () => {
  assert.deepEqual(packEntries(JSON.stringify([entry])), [entry])
  assert.deepEqual(packEntries(JSON.stringify({ '@x/visits': entry })), [entry])
  assert.deepEqual(packEntries('null'), [])
  assert.throws(() => packEntries('npm notice\n'), /unreadable file list/)
})
