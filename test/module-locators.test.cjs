const { test } = require('node:test')
const assert = require('node:assert/strict')
const { normalizeModuleLocator, resolveModuleRequirement } = require('../dist/module-locators.js')

for (const [input, expected] of [
  ['npm:@pkarw/marketing_consents@1.2.3', 'npm:@pkarw/marketing_consents'],
  ['@pkarw/marketing_consents@next', 'npm:@pkarw/marketing_consents'],
  ['npm:marketing_consents@latest', 'npm:marketing_consents'],
  ['github:Open-Mercato/marketing-consents#main', 'github:open-mercato/marketing-consents'],
  ['https://github.com/Open-Mercato/marketing-consents.git@1.2.3', 'github:open-mercato/marketing-consents'],
  ['git@github.com:Open-Mercato/marketing-consents.git', 'github:open-mercato/marketing-consents'],
  ['git+ssh://git@github.com/Open-Mercato/marketing-consents.git#main', 'github:open-mercato/marketing-consents'],
  ['github.com/Open-Mercato/marketing-consents.git', 'github:open-mercato/marketing-consents'],
  ['github:marketing-consents', 'github:marketing-consents'],
  ['marketing_consents', 'marketing_consents'],
]) test(`canonical locator parity: ${input}`, () => assert.equal(normalizeModuleLocator(input), expected))

test('repository shorthand requires a unique installed source', () => {
  const enabled = [{ id: 'marketing_consents', locators: ['github:pkarw/marketing-consents'] }]
  assert.equal(resolveModuleRequirement('marketing-consents', enabled), 'marketing_consents')
  assert.equal(resolveModuleRequirement('github:marketing-consents', enabled), 'marketing_consents')
  assert.equal(resolveModuleRequirement('marketing-consents', [...enabled, { id: 'other', locators: ['github:other/marketing-consents'] }]), undefined)
})

for (const input of ['https://example.com/owner/repo', 'npm:', 'owner/repo/extra', ' module name ', 'https://github.com/owner/repo/tree/main', 'npm:package@bad;selector'])
  test(`reject malformed locator: ${input}`, () => assert.equal(normalizeModuleLocator(input), null))

test('npm package names have the same registry length limit as installation', () => assert.equal(normalizeModuleLocator(`npm:${'a'.repeat(215)}`), null))
