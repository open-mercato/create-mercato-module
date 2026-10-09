import type { Settings, SavedSettings } from './types.js'
import { createInterface } from 'node:readline/promises'
import { findApp, validateId, run } from './common.js'
import { scaffold } from './scaffold.js'
import { validateSettings } from './package.js'
import { exportPackage, exportLinkedPackage, publish } from './publish.js'
import { loadConfig, saveConfig, saveDevelopment } from './config.js'
import { linkDevelopment } from './development.js'
import { checkAuthentication } from './npm-auth.js'

const help = `Create and publish one module from an existing Open Mercato app.

  npx create-mercato-module init visits
  npx create-mercato-module publish visits
  npx create-mercato-module link visits

Existing modules can be published directly; init is optional.
Settings are saved per module in .mercato/module-tool.json.

Publish options:
  --package @your-name/visits  npm package name
  --version 0.1.0             a new npm version
  --tag beta                  npm release channel (stable: latest; prerelease: next)
  --repo your-name/visits     optional dedicated GitHub repository; - skips GitHub
  --access public|restricted  npm and new GitHub repo visibility (default public)
  --auth auto|login|token|trusted  npm authentication (default auto)
  --configure                edit saved settings in the interactive wizard
  --dry-run                  build a local .tgz; no GitHub/npm writes or login needed
  --yes                      approve the displayed publication without a prompt

Link options:
  --package @your-name/visits  use this published module package
  --repo your-name/visits     its dedicated GitHub repository
  --no-generate              link without running yarn generate

Init options:
  --no-generate              create/register the module without running yarn generate

Publishing checks npm authentication before packaging; GitHub work checks gh auth.
Token authentication reads NPM_TOKEN or NODE_AUTH_TOKEN; never pass tokens as arguments.
Trusted publishing requires a configured npm trusted publisher and GitHub Actions OIDC.
The app repository, its origin, and all other modules are preserved.
`

type Flags = Record<string, string | boolean>
type ParsedArguments =
  { help: true } | { command: string; id: string; flags: Flags; help?: false }

function parse(argv: string[]): ParsedArguments {
  if (!argv.length || argv.includes('--help') || argv.includes('-h'))
    return { help: true }
  const [command, id, ...rest] = argv
  if (!['init', 'publish', 'link'].includes(command))
    throw new Error(
      'Choose init, publish, or link. Run with --help for examples.',
    )
  validateId(id)
  const flags: Flags = {}
  const booleans =
    command === 'publish' ? ['dry-run', 'yes', 'configure'] : ['no-generate']
  const values =
    command === 'publish'
      ? ['package', 'version', 'repo', 'access', 'auth', 'tag']
      : command === 'link'
        ? ['package', 'repo']
        : []
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index].replace(/^--/, '')
    if (rest[index] !== `--${key}` || Object.hasOwn(flags, key))
      throw new Error(`Invalid or repeated option: ${rest[index]}`)
    if (booleans.includes(key)) flags[key] = true
    else if (
      values.includes(key) &&
      rest[index + 1] &&
      !rest[index + 1].startsWith('--')
    )
      flags[key] = rest[++index]
    else throw new Error(`Unknown option or missing value: --${key}`)
  }
  return { command, id, flags }
}

function releaseTag(
  version: string,
  previous: Partial<SavedSettings>,
  flag: string | boolean | undefined,
): string {
  if (flag !== undefined) return String(flag)
  const defaultTag = version.includes('-') ? 'next' : 'latest'
  const previousDefault = previous.version?.includes('-') ? 'next' : 'latest'
  return previous.tag && previous.tag !== previousDefault
    ? previous.tag
    : defaultTag
}

function publicationSettings(
  previous: Partial<SavedSettings>,
  flags: Flags,
): Settings {
  const nextVersion =
    previous.lastPublishedVersion &&
    /^\d+\.\d+\.\d+$/.test(previous.lastPublishedVersion)
      ? previous.lastPublishedVersion.replace(/\d+$/, (patch) =>
          String(Number(patch) + 1),
        )
      : previous.version || '0.1.0'
  const version = String(flags.version || '') || nextVersion
  return {
    packageName: String(flags.package || '') || previous.packageName || '',
    version,
    tag: releaseTag(version, previous, flags.tag),
    repository:
      flags.repo === undefined
        ? (previous.repository ?? '')
        : String(flags.repo),
    access: String(flags.access || '') || previous.access || 'public',
    auth: String(flags.auth || '') || previous.auth || 'auto',
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parse(argv)
  if (args.help) return console.log(help)
  const app = findApp()
  if (args.command === 'init') {
    const directory = scaffold(app, args.id)
    console.log(`✅ Created ${directory}\n🧩 Registered in src/modules.ts.`)
    if (!args.flags['no-generate']) run('yarn', ['generate'], app.directory)
    console.log(
      `\nOpen /backend/${args.id} in the app. Build your feature in src/modules/${args.id}.\nWhen ready: npx create-mercato-module publish ${args.id}`,
    )
    return
  }
  const previous: Partial<SavedSettings> =
    loadConfig(app).modules[args.id] || {}
  const settings = publicationSettings(previous, args.flags)
  if (settings.repository === '-') settings.repository = ''
  const initialRepository = settings.repository
  const authenticatedMode =
    args.command === 'publish' && !args.flags['dry-run']
      ? checkAuthentication(app.directory, settings)
      : undefined
  if (authenticatedMode)
    console.log(`🔑 npm authentication ready (${authenticatedMode}).`)
  const interactive = Boolean(
    process.stdin.isTTY && !args.flags.yes && !args.flags['dry-run'],
  )
  const prompt = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null
  async function ask(label: string, value: string): Promise<string> {
    if (!prompt) return value
    const answer = await prompt.question(
      `${label}${value ? ` [${value}]` : ''}: `,
    )
    return answer.trim() || value
  }
  try {
    if (args.command === 'link') {
      if (!args.flags.package && !settings.packageName)
        settings.packageName = await ask(
          '📦 npm package from the dedicated module repository',
          '',
        )
      if (!args.flags.repo && !settings.repository)
        settings.repository = await ask(
          '🐙 Dedicated GitHub repo owner/name',
          '',
        )
      validateSettings(settings)
      if (!settings.repository || settings.repository === '-')
        throw new Error(
          '🐙 Linking development needs a dedicated GitHub repository. Publish with --repo owner/name first, or pass --repo owner/name to link.',
        )
      const development = linkDevelopment(app, args.id, {
        repository: settings.repository,
        packageName: settings.packageName,
        linkedDevelopment: previous.development,
      })
      saveDevelopment(app, args.id, development, settings)
      console.log(
        `\n🔗 src/modules/${args.id} now points to ${development.sourcePath}.\n🐙 Edit your module in this app; changes belong to ${development.repository}.\n📁 Previous local source: ${development.backupPath}\n🧩 Registration remains @app.`,
      )
      if (!args.flags['no-generate']) run('yarn', ['generate'], app.directory)
      console.log(
        `\nNext release: npx create-mercato-module publish ${args.id}`,
      )
      return
    }
    if (prompt) {
      console.log('\n🧩 Publish your Open Mercato module\n')
      const configure = Boolean(args.flags.configure)
      if (!args.flags.package && (configure || !previous.packageName))
        settings.packageName = await ask(
          '📦 npm package (for example @your-name/visits)',
          settings.packageName,
        )
      if (!args.flags.version && (configure || !previous.version))
        settings.version = await ask('🔖 Version', settings.version)
      if (
        args.flags.repo === undefined &&
        (configure || previous.repository === undefined)
      )
        settings.repository = await ask(
          '🐙 Dedicated GitHub repo owner/name (optional; use - to skip)',
          settings.repository || '',
        )
      if (!args.flags.access && (configure || !previous.access))
        settings.access = await ask(
          '🔐 Access: public or restricted',
          settings.access,
        )
    }
    if (settings.repository === '-') settings.repository = ''
    settings.tag = releaseTag(settings.version, previous, args.flags.tag)
    validateSettings(settings)
    if (!args.flags['dry-run'] && settings.repository) {
      if (settings.repository !== initialRepository)
        checkAuthentication(app.directory, settings)
      console.log('🐙 GitHub authentication ready.')
    }
    const prepared = previous.development
      ? exportLinkedPackage(app, args.id, settings, previous.development)
      : exportPackage(app, args.id, settings)
    console.log(
      `\n🧩 Module:     ${args.id} (${prepared.fileCount} source files)\n📦 Package:    ${settings.packageName}@${settings.version}\n🏷️ npm tag:    ${settings.tag}\n🔐 Access:     ${settings.access}\n🔑 npm auth:   ${settings.auth}\n🐙 GitHub:     ${settings.repository || 'skip'}\n📁 Archive:    ${prepared.archive}\n🔎 Integrity:  ${prepared.integrity}`,
    )
    if (args.flags['dry-run'])
      return console.log(
        '\n✅ Dry run complete. No npm/GitHub publication or app Git changes.',
      )
    if (
      !args.flags.yes &&
      (!prompt ||
        !/^y(?:es)?$/i.test(
          (
            await prompt.question(
              '\n🚀 Publish this module to the destinations above? [y/N] ',
            )
          ).trim(),
        ))
    ) {
      console.log(
        'ℹ️ Publication canceled. The local archive is available for inspection.',
      )
      return
    }
    saveConfig(app, args.id, settings, false)
    publish(prepared, settings)
    saveConfig(app, args.id, settings, true)
    console.log(
      `\n✅ Submitted ${settings.packageName}@${settings.version} to npm. Registry scanning may delay availability.\nInstall in another app once available:\n  yarn mercato module add ${settings.packageName}@${settings.version} --allow-third-party`,
    )
  } finally {
    prompt?.close()
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(
      `\n❌ ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  })
export { parse, main }
