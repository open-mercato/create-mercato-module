import type { App, Settings, PreparedPackage } from './types.js'
import * as fs from 'node:fs'
import * as ts from 'typescript'
import { version as typescriptVersion } from 'typescript'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { readJson, writeJson, moduleDirectory } from './common.js'
import { filesIn, rewriteSource, build, codePattern } from './build.js'
import { createPublishWorkflow } from './workflow.js'
import { assertNoCredentials } from './repository-safety.js'

// One wording for the Yarn release-age gate, after publish and in module READMEs.
const ageGateNote =
  'Apps created by create-mercato-app install npm versions only 5 days after publication (Yarn npmMinimalAgeGate). To install a new version sooner, add --preapprove-package: it adds only this package to the app\'s npmPreapprovedPackages.'

// Open Mercato Modules (the module catalog) and npm search find modules by
// these keywords; the catalog also reads the GitHub topics of the same names.
const moduleKeywords = ['open-mercato', 'open-mercato-module']
const catalogUrl = 'https://modules.openmercato.com'

function catalogSubmitUrl(packageName: string): string {
  return `${catalogUrl}/submit?npm=${packageName}`
}

const localLocator =
  /^(?:workspace:|file:|link:|portal:|patch:|git\+|git:|ssh:|https?:|github:)/

function validateSettings(settings: Settings): void {
  if (
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(
      settings.packageName || '',
    ) ||
    settings.packageName.length > 214
  )
    throw new Error(
      'Enter a valid npm package name, for example @your-name/visits.',
    )
  if (
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(
      settings.version || '',
    )
  )
    throw new Error('Enter a version such as 0.1.0 or 0.1.0-beta.1.')
  if (!['public', 'restricted'].includes(settings.access))
    throw new Error('Access must be public or restricted.')
  if (settings.access === 'restricted' && !settings.packageName.startsWith('@'))
    throw new Error(
      'Private npm packages need a scope. Use a name such as @your-name/visits with --access restricted.',
    )
  if (!['auto', 'login', 'token', 'trusted'].includes(settings.auth || 'auto'))
    throw new Error(
      'Choose --auth auto, login, token, or trusted. Token mode reads NPM_TOKEN or NODE_AUTH_TOKEN from the environment.',
    )
  if (
    settings.tag &&
    (!/^[a-z][a-z0-9._-]*$/.test(settings.tag) ||
      /^v?\d|^v?x(?:\.[0-9x]+){0,2}$/.test(settings.tag))
  )
    throw new Error(
      'Use an npm tag such as latest, next, or beta. Tags cannot be version numbers or version ranges.',
    )
  if (
    settings.repository &&
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
      settings.repository,
    )
  )
    throw new Error(
      'Use a GitHub repository name such as your-name/mercato-visits.',
    )
}

// Plain string fields of the module's `metadata` export (Open Mercato
// ModuleInfo), read from the syntax tree without running module code.
function moduleInfo(moduleRoot: string): { title?: string; description?: string } {
  let source: ts.SourceFile
  try {
    const file = path.join(moduleRoot, 'index.ts')
    source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
  } catch {
    return {}
  }
  const info: { title?: string; description?: string } = {}
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'metadata' &&
      node.initializer
    ) {
      let value = node.initializer
      while (
        ts.isAsExpression(value) ||
        ts.isSatisfiesExpression(value) ||
        ts.isParenthesizedExpression(value)
      )
        value = value.expression
      if (ts.isObjectLiteralExpression(value))
        for (const entry of value.properties)
          if (
            ts.isPropertyAssignment(entry) &&
            (ts.isIdentifier(entry.name) || ts.isStringLiteralLike(entry.name)) &&
            (entry.name.text === 'title' || entry.name.text === 'description') &&
            ts.isStringLiteralLike(entry.initializer) &&
            entry.initializer.text.trim()
          )
            info[entry.name.text] = entry.initializer.text.replace(/\s+/g, ' ').trim()
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return info
}

function installedVersion(app: App, name: string): string {
  const direct = path.join(app.directory, 'node_modules', name, 'package.json')
  if (fs.existsSync(direct)) return readJson(direct).version ?? ''
  const loader = createRequire(path.join(app.directory, 'package.json'))
  let directory
  try {
    directory = path.dirname(loader.resolve(name))
  } catch {
    throw new Error(
      `Dependency ${name} is not installed in the app. Install it before publishing.`,
    )
  }
  while (true) {
    const manifest = path.join(directory, 'package.json')
    if (fs.existsSync(manifest) && readJson(manifest).name === name)
      return readJson(manifest).version ?? ''
    const parent = path.dirname(directory)
    if (parent === directory)
      throw new Error(`Cannot find the installed version of ${name}.`)
    directory = parent
  }
}

function preparePackage(
  app: App,
  id: string,
  settings: Settings,
  destination: string,
  sourceDirectory?: string,
): PreparedPackage {
  validateSettings(settings)
  const sourceRoot = sourceDirectory ?? moduleDirectory(app, id)
  const files = filesIn(sourceRoot)
  const dependencies = new Set(['@open-mercato/core'])
  const rewritten = new Map<string, string>()
  for (const file of files) {
    const contents = fs.readFileSync(file)
    assertNoCredentials(path.relative(sourceRoot, file), contents)
    if (codePattern.test(file)) {
      const source = contents.toString('utf8')
      rewritten.set(
        file,
        rewriteSource(source, file, sourceRoot, id,
          (name) => dependencies.add(name), 'source'),
      )
      if (/\.[jt]sx$/.test(file)) dependencies.add('react')
    }
  }
  const peers: Record<string, string> = {}
  const runtime: Record<string, string> = {}
  for (const name of [...dependencies].sort()) {
    const declared =
      app.manifest.dependencies?.[name] ??
      app.manifest.devDependencies?.[name] ??
      app.manifest.peerDependencies?.[name]
    if (declared && localLocator.test(declared))
      throw new Error(
        `Dependency ${name} uses a local/Git locator. Publish that dependency first and install its npm version.`,
      )
    const version = installedVersion(app, name)
    if (!/^\d+\.\d+\.\d+/.test(version || ''))
      throw new Error(`Invalid installed version for ${name}.`)
    const singleton =
      name.startsWith('@open-mercato/') ||
      name.startsWith('@mikro-orm/') ||
      ['react', 'react-dom', 'next'].includes(name)
    ;(singleton ? peers : runtime)[name] = version
  }
  if (fs.existsSync(destination))
    throw new Error(`Export directory already exists: ${destination}`)
  fs.mkdirSync(destination, { recursive: true })
  for (const file of files) {
    const output = path.join(
      destination,
      'src/modules',
      id,
      path.relative(sourceRoot, file),
    )
    fs.mkdirSync(path.dirname(output), { recursive: true })
    if (rewritten.has(file)) fs.writeFileSync(output, rewritten.get(file)!)
    else fs.copyFileSync(file, output)
  }
  const repository =
    settings.repository ||
    (settings.auth === 'trusted' && process.env.GITHUB_REPOSITORY) ||
    ''
  const manifest = {
    name: settings.packageName,
    version: settings.version,
    description:
      moduleInfo(sourceRoot).description || `Open Mercato module: ${id}`,
    keywords: [...moduleKeywords],
    license: app.manifest.license || 'UNLICENSED',
    type: 'module',
    main: './dist/index.js',
    files: ['src', 'dist', 'types', 'build.cjs', 'README.md'],
    exports: {
      '.': { types: './types/index.ts', default: './dist/index.js' },
      './package.json': './package.json',
      './*.json': './dist/*.json',
      './*.ts': { types: './types/*.ts', default: './dist/*.js' },
      './*.tsx': { types: './types/*.tsx', default: './dist/*.js' },
      './*': {
        types: ['./types/*.ts', './types/*.tsx'],
        default: './dist/*.js',
      },
    },
    scripts: { build: 'node build.cjs', prepack: 'npm run build' },
    engines: { node: '>=24' },
    ...(Object.keys(runtime).length ? { dependencies: runtime } : {}),
    peerDependencies: peers,
    devDependencies: { typescript: typescriptVersion, ...peers },
    publishConfig: { access: settings.access },
    ...(repository
      ? {
          repository: {
            type: 'git',
            url: `git+https://github.com/${repository}.git`,
          },
          homepage: `https://github.com/${repository}#readme`,
          bugs: { url: `https://github.com/${repository}/issues` },
        }
      : {}),
    mercatoModule: { id, formatVersion: 1 },
  }
  writeJson(path.join(destination, 'package.json'), manifest)
  fs.writeFileSync(
    path.join(destination, 'src/index.ts'),
    `export { metadata } from './modules/${id}/index'\n`,
  )
  fs.writeFileSync(
    path.join(destination, 'src/.npmignore'),
    '**/__tests__/\n**/__integration__/\n**/__mocks__/\n**/*.test.*\n**/*.spec.*\n**/*.typecheck.*\n**/node_modules/\n**/.git/\n',
  )
  fs.copyFileSync(
    path.join(__dirname, 'build.js'),
    path.join(destination, 'build.cjs'),
  )
  fs.writeFileSync(
    path.join(destination, '.gitignore'),
    'node_modules\n*.tgz\n.env*\n!.env.example\n.npmrc\n',
  )
  fs.mkdirSync(path.join(destination, '.github/workflows'), { recursive: true })
  fs.writeFileSync(
    path.join(destination, '.github/workflows/publish.yml'),
    createPublishWorkflow(settings.access as 'public' | 'restricted'),
  )
  fs.writeFileSync(
    path.join(destination, 'README.md'),
    `# ${settings.packageName}\n\nInstall in an Open Mercato app:\n\n\`\`\`sh\nnpx create-mercato-module install ${settings.packageName}\n\`\`\`\n\n${ageGateNote.replace('--preapprove-package', '`--preapprove-package`').replace('npmMinimalAgeGate', '`npmMinimalAgeGate`').replace("app's npmPreapprovedPackages", "app's `npmPreapprovedPackages`")}\n\n${settings.repository ? `Or install from this repository; \`@<version>\` selects a release tagged by create-mercato-module:\n\n\`\`\`sh\nnpx create-mercato-module install ${settings.repository}\nnpx create-mercato-module install ${settings.repository}@${settings.version}\n\`\`\`\n\n` : ''}Develop in your existing app and publish another version with create-mercato-module. To make this repository the source of your module while keeping the same app for development:\n\n\`\`\`sh\nnpx create-mercato-module link ${settings.repository || settings.packageName}\n\`\`\`\n\nThe tool checks out this repo in the app's .mercato/module-repos/${id} directory, backs up the original module, and links src/modules/${id} to the checkout. Edits in the app are edits in this repository.\n\n${settings.access === 'public' ? `## Open Mercato Modules\n\nList this module in [Open Mercato Modules](${catalogSubmitUrl(settings.packageName)}) so people and coding agents can find it. In the app you develop it in, \`npx create-mercato-module describe ${id}\` prints its catalog entry.\n\n` : ''}## Trusted Publishing\n\nConfigure this package's trusted publisher on npmjs.com for the GitHub owner, repository, and workflow filename publish.yml. Then dispatch the included GitHub Actions workflow or push a v<version> tag matching package.json. Releases published with create-mercato-module are tagged <version> without the v, so they do not start this workflow, and the workflow skips a version that is already on npm. For private dependencies, set a read-only NPM_READ_TOKEN repository secret.\n\nSee [create-mercato-module](https://github.com/open-mercato/create-mercato-module) for authentication, release tests, and development details.\n`,
  )
  build(destination)
  return { destination, manifest, fileCount: files.length }
}

export {
  validateSettings,
  installedVersion,
  moduleInfo,
  preparePackage,
  localLocator,
  ageGateNote,
  moduleKeywords,
  catalogUrl,
  catalogSubmitUrl,
}
