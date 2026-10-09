#!/usr/bin/env node
const { createInterface } = require('node:readline/promises')
const { findApp, validateId, run } = require('../lib/common.cjs')
const { scaffold } = require('../lib/scaffold.cjs')
const { validateSettings } = require('../lib/package.cjs')
const { exportPackage, publish, loadConfig, saveConfig } = require('../lib/publish.cjs')

const help = `Create and publish one module from an existing Open Mercato app.

  npx create-mercato-module init visits
  npx create-mercato-module publish visits

Existing modules can be published directly; init is optional.

Publish options:
  --package @your-name/visits  npm package name
  --version 0.1.0             a new npm version
  --repo your-name/visits     optional dedicated GitHub repository
  --access public|restricted  npm and new GitHub repo visibility (default public)
  --dry-run                  build a local .tgz; no GitHub/npm writes or login needed
  --yes                      approve the displayed publication without a prompt

Init options:
  --no-generate              create/register the module without running yarn generate

Publishing requires npm login; GitHub export additionally requires gh auth login.
The app repository, its origin, and all other modules are preserved.
`

function parse(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) return { help: true }
  const [command, id, ...rest] = argv
  if (!['init', 'publish'].includes(command)) throw new Error('Choose init or publish. Run with --help for examples.')
  validateId(id)
  const flags = {}
  const booleans = command === 'init' ? ['no-generate'] : ['dry-run', 'yes']
  const values = command === 'publish' ? ['package', 'version', 'repo', 'access'] : []
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index].replace(/^--/, '')
    if (rest[index] !== `--${key}` || Object.hasOwn(flags, key)) throw new Error(`Invalid or repeated option: ${rest[index]}`)
    if (booleans.includes(key)) flags[key] = true
    else if (values.includes(key) && rest[index + 1] && !rest[index + 1].startsWith('--')) flags[key] = rest[++index]
    else throw new Error(`Unknown option or missing value: --${key}`)
  }
  return { command, id, flags }
}

async function main(argv = process.argv.slice(2)) {
  const args = parse(argv)
  if (args.help) return console.log(help)
  const app = findApp()
  if (args.command === 'init') {
    const directory = scaffold(app, args.id)
    console.log(`Created ${directory}\nRegistered in src/modules.ts.`)
    if (!args.flags['no-generate']) run('yarn', ['generate'], app.directory)
    console.log(`\nOpen /backend/${args.id} in the app. Build your feature in src/modules/${args.id}.\nWhen ready: npx create-mercato-module publish ${args.id}`)
    return
  }
  const previous = loadConfig(app).modules[args.id] || {}
  const nextVersion = previous.lastPublishedVersion && /^\d+\.\d+\.\d+$/.test(previous.lastPublishedVersion)
    ? previous.lastPublishedVersion.replace(/\d+$/, (patch) => String(Number(patch) + 1))
    : previous.version || '0.1.0'
  const settings = {
    packageName: args.flags.package || previous.packageName || '',
    version: args.flags.version || nextVersion,
    repository: args.flags.repo ?? previous.repository ?? '',
    access: args.flags.access || previous.access || 'public',
  }
  const interactive = Boolean(process.stdin.isTTY && !args.flags.yes && !args.flags['dry-run'])
  const prompt = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null
  try {
    async function ask(label, value) {
      const answer = await prompt.question(`${label}${value ? ` [${value}]` : ''}: `)
      return answer.trim() || value
    }
    if (prompt) {
      settings.packageName = await ask('npm package (for example @your-name/visits)', settings.packageName)
      settings.version = await ask('Version', settings.version)
      settings.repository = await ask('Dedicated GitHub repo owner/name (optional; use - to skip)', settings.repository)
      settings.access = await ask('Access: public or restricted', settings.access)
    }
    if (settings.repository === '-') settings.repository = ''
    validateSettings(settings)
    const prepared = exportPackage(app, args.id, settings)
    console.log(`\nModule:     ${args.id} (${prepared.fileCount} source files)\nPackage:    ${settings.packageName}@${settings.version}\nAccess:     ${settings.access}\nGitHub:     ${settings.repository || 'skip'}\nArchive:    ${prepared.archive}\nIntegrity:  ${prepared.integrity}`)
    if (args.flags['dry-run']) return console.log('\nDry run complete. No npm/GitHub publication or app Git changes.')
    if (!args.flags.yes && (!prompt || !/^y(?:es)?$/i.test((await prompt.question('\nPublish this module to the destinations above? [y/N] ')).trim()))) {
      console.log('Publication canceled. The local archive is available for inspection.')
      return
    }
    saveConfig(app, args.id, settings, false)
    publish(prepared, settings)
    saveConfig(app, args.id, settings, true)
    console.log(`\nPublished ${settings.packageName}@${settings.version}.\nInstall in another app:\n  yarn mercato module add ${settings.packageName}@${settings.version} --allow-third-party`)
  } finally { prompt?.close() }
}

if (require.main === module) main().catch((error) => { console.error(`\n${error.message}`); process.exitCode = 1 })
module.exports = { parse, main }
