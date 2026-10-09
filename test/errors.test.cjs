const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { rewriteSource } = require('../dist/build.js')
const { validateSettings } = require('../dist/package.js')

test('generated entity field import error identifies author source and explains a portable fix', () => {
  const root = path.resolve('/app/src/modules/patients')
  assert.throws(() => rewriteSource("import { id } from '@/.mercato/generated/entities/patient_address'\n", path.join(root, 'api/addresses/route.ts'), root, 'patients'), error => {
    assert.match(error.message, /Source file: src\/modules\/patients\/api\/addresses\/route\.ts/)
    assert.match(error.message, /Import: @\/\.mercato\/generated\/entities\/patient_address/)
    assert.match(error.message, /generated entity field names/)
    assert.match(error.message, /export const id = 'id' as const/)
    assert.match(error.message, /Do not move, edit, or publish/)
    assert.match(error.message, /No files were published/)
    return true
  })
})

test('private package validation explains scoped npm name before attempting publication', () => {
  assert.throws(() => validateSettings({ packageName: 'visits', version: '0.1.0', access: 'restricted' }), /Private npm packages need a scope[\s\S]*@your-name\/visits/)
})
