const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { scaffold } = require('../dist/scaffold.js')
const { saveConfig } = require('../dist/config.js')
const { writeJson } = require('../dist/common.js')

// JSON Schema of an Open Mercato Modules descriptor, as published at
// https://modules.openmercato.com/schema/descriptor-1.json (generated from the
// catalog's Zod schema with `io: 'input'`). Refresh this copy when the catalog
// publishes a new version of the schema.
const descriptorSchema = require('./fixtures/catalog/descriptor-1.json')

const settings = { packageName: '@fixture/visits', version: '0.1.0', access: 'public', repository: 'fixture/mercato-visits', auth: 'login' }

function fixture(context) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mercato-describe-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const app = { directory: path.join(root, 'app'), manifest: { name: 'fixture-app', private: true, dependencies: { '@open-mercato/core': '0.9.0' } } }
  writeJson(path.join(app.directory, 'package.json'), app.manifest)
  writeJson(path.join(app.directory, 'node_modules/@open-mercato/core/package.json'), { name: '@open-mercato/core', version: '0.9.0' })
  fs.mkdirSync(path.join(app.directory, 'src/modules'), { recursive: true })
  fs.writeFileSync(path.join(app.directory, 'src/modules.ts'), 'export const enabledModules = []\n')
  scaffold(app, 'visits')
  const index = path.join(app.directory, 'src/modules/visits/index.ts')
  const binary = path.join(root, 'bin')
  const opened = path.join(root, 'opened.json')
  fs.mkdirSync(binary)
  for (const name of ['open', 'xdg-open', 'explorer'])
    fs.writeFileSync(path.join(binary, name), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(opened)},JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o755 })
  function cli(args, env = {}) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/cli.js'), ...args], { cwd: app.directory, encoding: 'utf8', env: { ...process.env, MERCATO_CATALOG_URL: '', PATH: `${binary}${path.delimiter}${process.env.PATH}`, ...env } })
    return { ...result, output: `${result.stdout}\n${result.stderr}` }
  }
  return { app, index, opened, cli }
}

// The flat `key: value # comment` YAML that describe prints.
function parseYaml(text) {
  const entry = {}
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue
    const match = /^([A-Za-z]+): (.*)$/.exec(line)
    assert.ok(match, `unexpected YAML line: ${line}`)
    const quoted = /^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/.exec(match[2])
    entry[match[1]] = quoted ? JSON.parse(quoted[1]) : match[2].replace(/\s+#.*$/, '')
  }
  return entry
}

// The JSON Schema keywords descriptor-1.json uses; formats are annotations.
function schemaErrors(schema, value, at = 'descriptor') {
  const errors = []
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  if (schema.anyOf && schema.anyOf.every((option) => schemaErrors(option, value, at).length)) errors.push(`${at}: matches no allowed form`)
  if (schema.type && schema.type !== type) return [...errors, `${at}: expected ${schema.type}`]
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: not one of ${schema.enum.join(', ')}`)
  if (type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`)
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: does not match ${schema.pattern}`)
  }
  if (type === 'array') {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at}: more than ${schema.maxItems} items`)
    if (schema.items) value.forEach((item, index) => errors.push(...schemaErrors(schema.items, item, `${at}[${index}]`)))
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${at}.${key}: required`)
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...schemaErrors(schema.properties[key], item, `${at}.${key}`))
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: unknown field`)
    }
  }
  return errors
}

// Rules of the catalog's Zod schema that JSON Schema cannot carry
// (lib/schema/descriptor.ts and PlainText in lib/schema/common.ts).
function refinementErrors(entry) {
  const errors = []
  if (!entry.npm && !entry.github) errors.push('npm or github is required')
  if (typeof entry.summary === 'string' && entry.summary.length < 20) errors.push('summary: min 20 characters')
  if (typeof entry.whenToUse === 'string' && !(entry.whenToUse.startsWith('Use when ') && entry.whenToUse.length >= 40)) errors.push('whenToUse: start with "Use when ", min 40 characters')
  for (const field of ['summary', 'whenToUse']) {
    // eslint-disable-next-line no-control-regex
    if (/https?:\/\/|www\.|[[\]`<>]|(^|\s)\*|^\s*#|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]|[\n\r\t]|[\u2013\u2014]/i.test(entry[field] ?? '')) errors.push(`${field}: plain text only`)
  }
  return errors
}

function assertCatalogEntry(yaml) {
  const entry = parseYaml(yaml)
  assert.deepEqual([...schemaErrors(descriptorSchema, entry), ...refinementErrors(entry)], [], yaml)
  return entry
}

test('the contract checker rejects entries the catalog rejects', () => {
  const valid = { npm: '@fixture/visits', category: 'operations', summary: 'Tracks customer visits in the backend.', whenToUse: 'Use when the team must plan and record customer visits.' }
  assert.deepEqual([...schemaErrors(descriptorSchema, valid), ...refinementErrors(valid)], [])
  for (const invalid of [
    { ...valid, category: 'visits' },
    { ...valid, unknown: true },
    { ...valid, summary: 'Too short.' },
    { ...valid, whenToUse: 'When the team must plan and record customer visits.' },
    { ...valid, summary: 'See https://example.com for the visits module.' },
    { ...valid, npm: undefined },
  ]) {
    const entry = JSON.parse(JSON.stringify(invalid))
    assert.notDeepEqual([...schemaErrors(descriptorSchema, entry), ...refinementErrors(entry)], [], JSON.stringify(entry))
  }
})

test('describe prints a catalog entry from saved settings and the module metadata', (context) => {
  const { app, index, cli } = fixture(context)
  fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace("  description: '',", "  description: 'Plans customer visits: routes, notes and follow-ups.',"))
  saveConfig(app, 'visits', settings, true)
  const before = fs.readFileSync(path.join(app.directory, '.mercato/module-tool.json'), 'utf8')
  const result = cli(['describe', 'visits'])
  assert.equal(result.status, 0, result.output)
  const entry = assertCatalogEntry(result.stdout)
  assert.equal(entry.npm, '@fixture/visits')
  assert.equal(entry.github, 'fixture/mercato-visits')
  assert.equal(entry.summary, 'Plans customer visits: routes, notes and follow-ups.')
  assert.match(result.stdout, /^npm: "@fixture\/visits"$/m)
  assert.doesNotMatch(result.stderr, /description/, 'a usable description needs no warning')
  assert.match(result.stdout, /^summary: "Plans customer visits: routes, notes and follow-ups\."$/m, 'a ": " inside a value needs quotes')
  assert.match(result.stdout, /^category: operations # choose the category that fits$/m, 'a fitting default category needs no edit')
  assert.match(result.stdout, /^# Write each value marked TODO, then delete those TODO comments/m)
  assert.match(result.stdout, /^whenToUse: Use when an Open Mercato app needs the Visits module\. # TODO/m)
  assert.match(result.stdout, /https:\/\/modules\.openmercato\.com\/submit\?npm=@fixture\/visits\n# Open Mercato Modules has not launched yet, so this link does not open until it does\.\n/)
  assert.doesNotMatch(result.stdout, /github\.io/)
  assert.equal(fs.readFileSync(path.join(app.directory, '.mercato/module-tool.json'), 'utf8'), before, 'describe changes no files')
})

test('describe falls back to a valid summary when the module has no usable description', (context) => {
  const { app, index, cli } = fixture(context)
  saveConfig(app, 'visits', { ...settings, repository: '' }, true)
  for (const description of [undefined, 'Short.', 'Read https://example.com first, then plan customer visits.']) {
    const source = fs.readFileSync(index, 'utf8').replace(/ {2}description: .*\n/, '')
    fs.writeFileSync(index, description ? source.replace("  ejectable: true,\n", `  ejectable: true,\n  description: '${description}',\n`) : source)
    const result = cli(['describe', 'visits'])
    assert.equal(result.status, 0, result.output)
    const entry = assertCatalogEntry(result.stdout)
    assert.equal(entry.summary, 'Visits module for Open Mercato apps.')
    assert.match(result.stdout, /^summary: .* # TODO/m)
    assert.equal(entry.github, undefined, 'an npm-only module has no github field')
    assert.match(result.stderr, description
      ? /⚠️ The description of visits cannot be the catalog summary: Write .*Set description in the metadata in src\/modules\/visits\/index\.ts/
      : /⚠️ Module visits has no description\. Set description in the metadata in src\/modules\/visits\/index\.ts \(one sentence, 20 to 140 characters\): it becomes the catalog summary/)
  }
})

test('describe reads only the exported top-level metadata binding', (context) => {
  const { app, index, cli } = fixture(context)
  saveConfig(app, 'visits', settings, true)
  const exported = "export const metadata = {\n  name: 'visits',\n  title: 'Visits',\n  description: 'Plans customer visits: routes, notes and follow-ups.',\n}\n"
  const local = "const metadata = { title: 'Other', description: 'A local helper value that the descriptor must ignore.' }"
  for (const [kind, helper] of [
    ['function', `function helper() {\n  ${local}\n  return metadata\n}\n`],
    ['block', `{\n  ${local}\n  void metadata\n}\n`],
    ['arrow function', `export const helper = () => {\n  ${local}\n  return metadata\n}\n`],
  ]) {
    fs.writeFileSync(index, exported + helper)
    const result = cli(['describe', 'visits'])
    assert.equal(result.status, 0, result.output)
    const entry = assertCatalogEntry(result.stdout)
    assert.equal(entry.summary, 'Plans customer visits: routes, notes and follow-ups.', `a local metadata in a ${kind} keeps the exported description`)
    assert.equal(entry.whenToUse, 'Use when an Open Mercato app needs the Visits module.', `a local metadata in a ${kind} keeps the exported title`)
  }
  fs.writeFileSync(index, "const metadata = {\n  title: 'Field Visits',\n  description: 'Plans field visits: routes, notes and follow-ups.',\n}\n\nexport { metadata }\n")
  const named = cli(['describe', 'visits'])
  assert.equal(named.status, 0, named.output)
  const entry = assertCatalogEntry(named.stdout)
  assert.equal(entry.summary, 'Plans field visits: routes, notes and follow-ups.', 'export { metadata } names the binding')
  assert.equal(entry.whenToUse, 'Use when an Open Mercato app needs the Field Visits module.')
  fs.writeFileSync(index, `export function helper() {\n  ${local}\n  return metadata\n}\n`)
  const nested = cli(['describe', 'visits'])
  assert.equal(nested.status, 0, nested.output)
  assert.equal(assertCatalogEntry(nested.stdout).summary, 'Visits module for Open Mercato apps.', 'a nested metadata alone is no metadata')
  assert.match(nested.stderr, /⚠️ Module visits has no description\./)
})

test('describe explains what is missing and opens the submit page on request', (context) => {
  const { app, opened, cli } = fixture(context)
  const unsaved = cli(['describe', 'visits'])
  assert.equal(unsaved.status, 1)
  assert.match(unsaved.output, /Module visits has no saved npm package\. Publish it first: npx create-mercato-module publish visits\nOr name the package it will be published as: npx create-mercato-module describe visits --package @your-name\/mercato-visits/)
  const early = cli(['describe', 'visits', '--package', '@fixture/mercato-visits'])
  assert.equal(early.status, 0, early.output)
  assert.equal(assertCatalogEntry(early.stdout).npm, '@fixture/mercato-visits', 'describe works before the first publish')
  assert.match(early.stdout, /^# Publish the package to npm before you submit: the catalog reads it from npm\.$/m)
  assert.ok(!fs.existsSync(path.join(app.directory, '.mercato/module-tool.json')), 'describe saves nothing')
  assert.match(cli(['describe', 'visits', '--package', 'Not A Name']).output, /Enter a valid npm package name/)
  saveConfig(app, 'visits', { ...settings, access: 'restricted' }, true)
  const restricted = cli(['describe', 'visits'])
  assert.equal(restricted.status, 1)
  assert.match(restricted.output, /restricted npm package\. Open Mercato Modules lists public packages only/)
  saveConfig(app, 'visits', settings, true)
  assert.doesNotMatch(cli(['describe', 'visits']).stdout, /Publish the package to npm/, 'a released package needs no reminder')
  const other = cli(['describe', 'visits', '--package', '@fixture/other-visits'])
  assert.equal(assertCatalogEntry(other.stdout).github, undefined, 'the saved repository belongs to the saved package')
  const pending = cli(['describe', 'visits', '--open'])
  assert.equal(pending.status, 0, pending.output)
  assert.ok(!fs.existsSync(opened), 'a catalog that has not launched is not opened')
  assert.match(pending.stderr, /Open Mercato Modules has not launched yet/)
  const open = cli(['describe', 'visits', '--open'], { MERCATO_CATALOG_URL: 'http://127.0.0.1:4321/' })
  assert.equal(open.status, 0, open.output)
  assert.deepEqual(JSON.parse(fs.readFileSync(opened, 'utf8')), ['http://127.0.0.1:4321/submit?npm=@fixture/visits'], 'MERCATO_CATALOG_URL names the catalog deployment')
  assert.doesNotMatch(open.stdout, /not launched/)
  for (const name of ['open', 'xdg-open', 'explorer'])
    fs.writeFileSync(path.join(path.dirname(opened), 'bin', name), `#!${process.execPath}\nprocess.exit(1)\n`, { mode: 0o755 })
  const failed = cli(['describe', 'visits', '--open'], { MERCATO_CATALOG_URL: 'http://127.0.0.1:4321/' })
  assert.equal(failed.status, 0, failed.output)
  assertCatalogEntry(failed.stdout)
  assert.doesNotMatch(failed.stdout, /in your browser/, 'redirected stdout stays valid YAML')
  assert.match(failed.stderr, /^Open http:\/\/127\.0\.0\.1:4321\/submit\?npm=@fixture\/visits in your browser\.$/m)
  const ignored = cli(['describe', 'visits'], { MERCATO_CATALOG_URL: 'javascript:alert(1)' })
  assert.match(ignored.stdout, /^# https:\/\/modules\.openmercato\.com\/submit/m, 'only http(s) origins override the catalog')
  for (const [field, value, message] of [
    ['packageName', '@fixture/visits\nsummary: injected', /Enter a valid npm package name/],
    ['repository', 'fixture/visits\nsummary: injected', /Use a GitHub repository name/],
  ]) {
    const file = path.join(app.directory, '.mercato/module-tool.json')
    const config = JSON.parse(fs.readFileSync(file, 'utf8'))
    config.modules.visits = { ...config.modules.visits, ...settings, [field]: value }
    fs.writeFileSync(file, JSON.stringify(config))
    const edited = cli(['describe', 'visits'])
    assert.equal(edited.status, 1, `a hand-edited ${field} is validated`)
    assert.match(edited.output, message)
    assert.doesNotMatch(edited.stdout, /injected/)
  }
  assert.match(cli(['describe', 'visits', '--yes']).output, /Unknown option or missing value: --yes/)
  assert.match(cli(['describe', '../visits']).output, /snake_case/)
})
