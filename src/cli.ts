import type { Settings, SavedSettings } from './types.js'
import { createInterface } from 'node:readline/promises'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { findApp, validateId, run } from './common.js'
import { scaffold } from './scaffold.js'
import {
  ageGateNote,
  catalogOpen,
  catalogPendingNote,
  catalogSubmitUrl,
  catalogUrl,
} from './package.js'
import { validateSettings } from './package.js'
import {
  exportPackage,
  exportLinkedPackage,
  publish,
  inspectRepository,
  publicationRisks,
} from './publish.js'
import { loadConfig, saveConfig, removeDevelopment } from './config.js'
import { isUnconfiguredLocalModule, linkFromInput } from './link.js'
import { validateCheckoutName, unlinkDevelopment } from './development.js'
import { checkAuthentication, resolveRegistry } from './npm-auth.js'
import {
  describeModule,
  descriptionProblem,
  descriptionWarning,
  moduleDescription,
  openCatalogPage,
} from './describe.js'
import {
  installFromInput,
  GitRepositoryApprovalRequired,
  PackageQuarantined,
} from './install.js'

const help = `Create and publish one module from an existing Open Mercato app.

  npx create-mercato-module init visits
  npx create-mercato-module publish visits
  npx create-mercato-module install <repo-or-npm-package>
  npx create-mercato-module install pkarw/marketing-consents
  npx create-mercato-module install your-name/mercato-visits@1.2.3
  npx create-mercato-module install @piotrkarwatka/marketing-consents
  npx create-mercato-module link <repo-or-npm-package> [local-name]
  npx create-mercato-module link pkarw/marketing-consents
  npx create-mercato-module link @piotrkarwatka/marketing-consents
  npx create-mercato-module unlink marketing_consents
  npx create-mercato-module describe visits

Existing modules can be published directly; init is optional.
Settings are saved per module in .mercato/module-tool.json.

Publish options:
  --package @your-name/mercato-visits  npm package name
  --version 0.1.0             a new npm version
  --tag beta                  npm release channel (stable: latest; prerelease: next)
  --repo your-name/mercato-visits  optional dedicated GitHub repository; - skips GitHub
  --access public|restricted  npm and new GitHub repo visibility (default public)
  --auth auto|login|token|trusted  npm authentication (default auto)
  --configure                edit saved settings in the interactive wizard
  --dry-run                  build a local .tgz; no GitHub/npm writes or login needed
  --yes                      approve the displayed publication without a prompt
  --allow-public-repo        approve pushing a restricted package's source to a public repo
  --overwrite-repo           approve replacing repository changes this app did not release
  --allow-branch             approve releasing a linked module from a non-default branch
  --allow-install-scripts    approve publishing install scripts from the module repository

Link options:
  Repository URL, owner/repo, or repo name (your GitHub account).
  npm packages discover their GitHub repository automatically.
  Package name and module ID are read from the repository.
  Existing unsaved local module IDs prompt for --repo to preserve the legacy form.
  local-name optionally names the checkout folder; the module ID stays the same.
  --package @your-name/mercato-visits  optional package identity check
  --repo your-name/mercato-visits  repository override for link <module_id>
  --no-generate              link without running yarn generate

Unlink:
  Makes a linked module local again: copies the checkout's current source into
  src/modules/<module_id> and forgets the link. The checkout and backup are kept.

Describe:
  Prints the module's Open Mercato Modules entry (YAML) from its saved
  publish settings, to list it at ${catalogUrl}/submit${catalogOpen ? '' : '\n  (not launched yet)'}.
  --open                     also open the submit page for the package
  --package @your-name/mercato-visits  describe it before the first publish

Install options:
  Repository URL, owner/repo, or repo name (your GitHub account).
  owner/repo@version-or-ref   select a GitHub version, tag, branch, or commit
  Numeric @versions try the exact ref, then v<version> only if it is missing.
  Scoped npm packages and npm:package-name install from npm.
  Package name and module ID are discovered automatically.
  --package @your-name/mercato-visits  optional package identity check
  --module module_id         choose one module from a multi-module package
  --ref tag|branch|commit    pin an exact Git ref; must match a locator ref
  --eject                    copy ejectable module source into src/modules
  --approve-git-repository    approve adding the requested GitHub URL to Yarn's allowlist if blocked
  --preapprove-package       approve adding the npm package to Yarn's npmPreapprovedPackages
                             if its version is younger than the app's npmMinimalAgeGate

Init options:
  --description "Plans customer visits and their follow-ups."
                             one sentence, 20 to 140 characters, for npm and the catalog
                             (asked in a terminal; Enter skips)
  --no-generate              create/register the module without running yarn generate

Nothing is published without approval: interactively you retype the package name;
scripts and CI pass --yes plus the --allow/--overwrite option for each listed warning.
Publishing checks npm authentication before packaging; GitHub work checks gh auth.
Token authentication reads NPM_TOKEN or NODE_AUTH_TOKEN; never pass tokens as arguments.
Trusted publishing requires a configured npm trusted publisher and GitHub Actions OIDC.
The app repository, its origin, and all other modules are preserved.
`

type Flags = Record<string, string | boolean>
type ParsedArguments =
  | { help: true }
  | {
      command: string
      id: string
      localName?: string
      flags: Flags
      help?: false
    }

function parse(argv: string[]): ParsedArguments {
  if (!argv.length || argv.includes('--help') || argv.includes('-h'))
    return { help: true }
  const [command, ...rest] = argv
  const positional: string[] = []
  if (
    !['init', 'publish', 'install', 'link', 'unlink', 'describe'].includes(
      command,
    )
  )
    throw new Error(
      'Choose init, publish, install, link, unlink, or describe. Run with --help for examples.',
    )
  const flags: Flags = {}
  const booleans =
    command === 'publish'
      ? [
          'dry-run',
          'yes',
          'configure',
          'allow-public-repo',
          'overwrite-repo',
          'allow-branch',
          'allow-install-scripts',
        ]
      : command === 'install'
        ? ['eject', 'approve-git-repository', 'preapprove-package']
        : command === 'unlink'
          ? []
          : command === 'describe'
            ? ['open']
            : ['no-generate']
  const values =
    command === 'publish'
      ? ['package', 'version', 'repo', 'access', 'auth', 'tag']
      : command === 'link'
        ? ['package', 'repo']
        : command === 'install'
          ? ['package', 'module', 'ref']
          : command === 'describe'
            ? ['package']
            : command === 'init'
              ? ['description']
              : []
  for (let index = 0; index < rest.length; index += 1) {
    if (!rest[index].startsWith('-')) {
      positional.push(rest[index])
      continue
    }
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
  const [id = '', localName] = positional
  if (positional.length > (command === 'link' ? 2 : 1))
    throw new Error(
      command === 'link'
        ? 'Too many arguments. Use link <repo-or-npm-package> [local-name].'
        : 'Too many arguments. Use one module name or locator.',
    )
  if (!['link', 'install'].includes(command)) validateId(id)
  if (command === 'install' && flags.module)
    validateId(String(flags.module))
  if (localName) validateCheckoutName(localName)
  return { command, id, flags, ...(localName ? { localName } : {}) }
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
  const releasedVersion =
    previous.lastPublishedVersion ||
    (previous.development ? previous.version : undefined)
  const releasedParts =
    /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.exec(
      releasedVersion || '',
    )
  const nextVersion = releasedParts
    ? `${releasedParts[1]}.${releasedParts[2]}.${Number(releasedParts[3]) + 1}`
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
    let description = String(args.flags.description ?? '').trim()
    const problem = description && descriptionProblem(description)
    if (problem)
      throw new Error(`${problem} No files were changed.`)
    if (
      !args.flags.description &&
      process.stdin.isTTY &&
      !fs.existsSync(path.join(app.directory, 'src/modules', args.id))
    ) {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      try {
        for (;;) {
          description = (
            await prompt.question(
              '📝 What does the module do? One sentence, 20 to 140 characters, for npm and Open Mercato Modules (Enter to skip): ',
            )
          ).trim()
          const answerProblem = description && descriptionProblem(description)
          if (!answerProblem) break
          console.log(answerProblem)
        }
      } finally {
        prompt.close()
      }
    }
    const directory = scaffold(app, args.id, description)
    console.log(`✅ Created ${directory}\n🧩 Registered in src/modules.ts.`)
    if (!args.flags['no-generate']) run('yarn', ['generate'], app.directory)
    console.log(
      `\nOpen /backend/${args.id} in the app. Build your feature in src/modules/${args.id}.\n🤖 Tip: with the app running (yarn setup), open it in your coding agent to build the module further.\nWhen ready: npx create-mercato-module publish ${args.id}`,
    )
    return
  }
  if (args.command === 'link') {
    let input = args.id
    let prompt: ReturnType<typeof createInterface> | undefined
    const linkPrompt = () => {
      prompt ??= createInterface({ input: process.stdin, output: process.stdout })
      return prompt
    }
    if (!input && process.stdin.isTTY) {
      input = (
        await linkPrompt().question('🐙 GitHub repository or npm package: ')
      ).trim()
    }
    try {
      if (!input)
        throw new Error(
          'Provide a GitHub repository or npm package: npx create-mercato-module link pkarw/marketing-consents',
        )
      if (
        !args.flags.repo &&
        isUnconfiguredLocalModule(app, input)
      ) {
        if (!process.stdin.isTTY)
          throw new Error(
            `The local module ${input} has no saved repository. Preserve the legacy module form with --repo owner/repository, or pass an explicit owner/repository to link a bare repository name. No files were changed.`,
          )
        const repository = (
          await linkPrompt().question(
            `🐙 Dedicated GitHub repo for local module ${input} (owner/repository): `,
          )
        ).trim()
        if (!repository)
          throw new Error(
            `The local module ${input} needs --repo owner/repository before it can be linked. No files were changed.`,
          )
        args.flags.repo = repository
      }
      const { id, development } = linkFromInput(
        app,
        input,
        args.localName,
        args.flags,
      )
      console.log(
        `\n🔗 src/modules/${id} now points to ${development.sourcePath}.\n📦 Package: ${development.packageName}\n🐙 Edit your module in this app; changes belong to ${development.repository}.${development.backupPath ? `\n📁 Previous local source: ${development.backupPath}` : ''}\n🧩 Registered as @app.`,
      )
      if (!args.flags['no-generate']) run('yarn', ['generate'], app.directory)
      console.log(`\nNext release: npx create-mercato-module publish ${id}`)
      return
    } finally {
      prompt?.close()
    }
  }
  if (args.command === 'unlink') {
    const development = loadConfig(app).modules[args.id]?.development
    if (!development)
      throw new Error(
        `Module ${args.id} is not linked to a repository checkout. No files were changed.`,
      )
    unlinkDevelopment(app, args.id, development, () =>
      removeDevelopment(app, args.id),
    )
    console.log(
      `\n✅ src/modules/${args.id} is a local module again, copied from ${development.checkoutPath}.\n📁 Kept: ${development.checkoutPath}${development.backupPath ? ` and the source from before linking, ${development.backupPath}` : ''}. Delete them once you no longer need them.\n🧩 src/modules.ts is unchanged.\n\nNext release from the app: npx create-mercato-module publish ${args.id}`,
    )
    return
  }
  if (args.command === 'describe') {
    const described = describeModule(
      app,
      args.id,
      args.flags.package ? String(args.flags.package) : undefined,
    )
    process.stdout.write(described.yaml)
    if (described.warning) console.error(`\n${described.warning}`)
    if (args.flags.open && !catalogOpen)
      console.error(`\n${catalogPendingNote}`)
    else if (args.flags.open && !openCatalogPage(described.submitUrl))
      console.log(`Open ${described.submitUrl} in your browser.`)
    return
  }
  if (args.command === 'install') {
    let input = args.id
    if (!input && process.stdin.isTTY) {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      try {
        input = (
          await prompt.question('📦 GitHub repository or npm package: ')
        ).trim()
      } finally {
        prompt.close()
      }
    }
    if (!input)
      throw new Error(
        'Provide a GitHub repository or npm package: npx create-mercato-module install pkarw/marketing-consents',
      )
    const options = {
      eject: Boolean(args.flags.eject),
      expectedPackage: args.flags.package
        ? String(args.flags.package)
        : undefined,
      moduleId: args.flags.module ? String(args.flags.module) : undefined,
      ref: args.flags.ref ? String(args.flags.ref) : undefined,
      approveGitRepository: Boolean(args.flags['approve-git-repository']),
      preapprovePackage: Boolean(args.flags['preapprove-package']),
    }
    let installed
    for (;;) {
      try {
        installed = installFromInput(app, input, options)
        break
      } catch (error) {
        const approval =
          error instanceof GitRepositoryApprovalRequired
            ? { question: 'Add this repository to Yarn approvals and retry?', option: 'approveGitRepository' as const }
            : error instanceof PackageQuarantined
              ? { question: "Add this package to Yarn's preapproved packages and retry?", option: 'preapprovePackage' as const }
              : undefined
        if (!approval || options[approval.option] || !process.stdin.isTTY) throw error
        console.log(`\n${error instanceof Error ? error.message : String(error)}`)
        const prompt = createInterface({ input: process.stdin, output: process.stdout })
        let answer: string
        try {
          answer = (await prompt.question(`\n👉 ${approval.question} [y/N] `)).trim().toLowerCase()
        } finally {
          prompt.close()
        }
        if (!['y', 'yes'].includes(answer))
          throw new Error('Installation cancelled. Yarn approvals were not changed.', { cause: error })
        options[approval.option] = true
      }
    }
    console.log(
      `\n✅ Installed ${installed.packageName} and enabled its Open Mercato module.${installed.repository ? `\n🐙 Source: ${installed.repository}` : `\n📦 Source: ${installed.specifier}`}${args.flags.eject ? '\n📁 Module source was ejected into this app.' : ''}`,
    )
    return
  }
  const previous: Partial<SavedSettings> =
    loadConfig(app).modules[args.id] || {}
  const settings = publicationSettings(previous, args.flags)
  if (settings.repository === '-') settings.repository = ''
  const initialRepository = settings.repository
  if (args.command === 'publish' && process.env.MERCATO_NPM_REGISTRY)
    console.log(
      `🧪 Using the local test registry ${resolveRegistry()} (MERCATO_NPM_REGISTRY). Nothing is sent to npmjs.com.`,
    )
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
    if (prompt) {
      console.log('\n🧩 Publish your Open Mercato module\n')
      const configure = Boolean(args.flags.configure)
      if (!args.flags.package && (configure || !previous.packageName))
        settings.packageName = await ask(
          '📦 npm package (for example @your-name/mercato-visits)',
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
    const repository =
      !args.flags['dry-run'] && settings.repository
        ? inspectRepository(settings.repository, app.directory)
        : undefined
    const destination = !settings.repository
      ? 'skip'
      : !repository
        ? settings.repository
        : repository.state === 'missing'
          ? `${settings.repository} (new ${settings.access === 'public' ? 'PUBLIC' : 'private'} repository will be created before npm publication; it stays if npm rejects the package; tagged ${settings.version} and given the open-mercato-module and open-mercato topics once npm accepts it)`
          : `${settings.repository} (existing ${repository.private ? 'private' : 'PUBLIC'} repository; tagged ${settings.version} and given the open-mercato-module and open-mercato topics once npm accepts it)`
    console.log(
      `\n🧩 Module:     ${args.id} (${prepared.fileCount} source files)\n📦 Package:    ${settings.packageName}@${settings.version}\n🏷️ npm tag:    ${settings.tag}\n🔐 Access:     ${settings.access}\n🔑 npm auth:   ${settings.auth}\n🐙 GitHub:     ${destination}\n📁 Archive:    ${prepared.archive}\n🔎 Integrity:  ${prepared.integrity}`,
    )
    const risks = publicationRisks(prepared, settings, repository)
    for (const risk of risks)
      console.log(`\n⚠️ ${risk.message}\n   Option: --${risk.flag}`)
    for (const note of prepared.notes ?? []) console.log(`\nℹ️ ${note}`)
    const descriptionNote = descriptionWarning(
      args.id,
      prepared.manifest.description,
      moduleDescription(app, args.id, previous.development).file,
      settings.access === 'public',
    )
    if (descriptionNote)
      console.log(
        `\n${descriptionNote}${prompt ? ' To include it in this version, cancel below, set it and publish again.' : ''}`,
      )
    if (args.flags['dry-run'])
      return console.log(
        `\n✅ Dry run complete. No npm/GitHub publication or app Git changes.${settings.repository ? '\nℹ️ GitHub checks (repository visibility, unreleased commits, branch) run when you publish.' : ''}`,
      )
    if (!prompt) {
      const missing = [
        ...(args.flags.yes ? [] : ['yes']),
        ...risks.map((risk) => risk.flag).filter((flag) => !args.flags[flag]),
      ]
      if (missing.length)
        throw new Error(
          `Nothing was published: this publication needs your approval. Review the summary above, then rerun with ${missing.map((flag) => `--${flag}`).join(' ')}, or run in a terminal to confirm interactively. The local archive is available for inspection.`,
        )
    } else if (
      (
        await prompt.question(
          `\n🚀 Publish this module to the destinations above? Type the package name (${settings.packageName}) to confirm: `,
        )
      ).trim() !== settings.packageName
    ) {
      console.log(
        'ℹ️ Publication canceled: the package name was not confirmed. The local archive is available for inspection.',
      )
      // Scripts wrapping the wizard must not mistake a cancellation for a release.
      process.exitCode = 1
      return
    }
    saveConfig(app, args.id, settings, false)
    const released = publish(prepared, settings, undefined, {
      // Linked checkouts are the source and are never overwritten.
      ...(repository && !prepared.linkedCheckout
        ? { expectedHead: repository.head ?? null }
        : {}),
    })
    saveConfig(app, args.id, settings, true)
    if (released.tag)
      console.log(`\n🏷️ Tagged ${settings.repository} ${released.tag}.`)
    if (released.tagWarning) console.log(`\n⚠️ ${released.tagWarning}`)
    console.log(
      `\n✅ Submitted ${settings.packageName}@${settings.version} to npm. Registry scanning may delay availability.\nInstall in another app once available:\n  npx create-mercato-module install ${settings.packageName}@${settings.version}${released.tag ? `\n  npx create-mercato-module install ${settings.repository}@${released.tag}` : ''}\n⏳ ${ageGateNote}${settings.access === 'public' ? `\n📚 Add it to the catalog: ${catalogSubmitUrl(settings.packageName)}${catalogOpen ? '' : `\n   ${catalogPendingNote}`}\n   Print its catalog entry: npx create-mercato-module describe ${args.id}` : ''}`,
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
