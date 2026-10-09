const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { readJson, writeJson, moduleDirectory } = require('./common.cjs')
const { filesIn, rewriteSource, build, codePattern } = require('./build.cjs')

function validateSettings(settings) {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(settings.packageName || '') || settings.packageName.length > 214) throw new Error('Enter a valid npm package name, for example @your-name/visits.')
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(settings.version || '')) throw new Error('Enter a version such as 0.1.0 or 0.1.0-beta.1.')
  if (!['public', 'restricted'].includes(settings.access)) throw new Error('Access must be public or restricted.')
  if (settings.repository && !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(settings.repository)) throw new Error('Use a GitHub repository name such as your-name/mercato-visits.')
}

function installedVersion(app, name) {
  const direct = path.join(app.directory, 'node_modules', name, 'package.json')
  if (fs.existsSync(direct)) return readJson(direct).version
  const loader = createRequire(path.join(app.directory, 'package.json'))
  let directory
  try { directory = path.dirname(loader.resolve(name)) } catch { throw new Error(`Dependency ${name} is not installed in the app. Install it before publishing.`) }
  while (true) {
    const manifest = path.join(directory, 'package.json')
    if (fs.existsSync(manifest) && readJson(manifest).name === name) return readJson(manifest).version
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`Cannot find the installed version of ${name}.`)
    directory = parent
  }
}

function preparePackage(app, id, settings, destination) {
  validateSettings(settings)
  const sourceRoot = moduleDirectory(app, id)
  const files = filesIn(sourceRoot)
  const dependencies = new Set(['@open-mercato/core'])
  const rewritten = new Map()
  for (const file of files) {
    const contents = fs.readFileSync(file)
    if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,})/.test(contents.toString('utf8'))) throw new Error(`Possible credential in ${path.relative(sourceRoot, file)}. Remove it before publishing.`)
    if (codePattern.test(file)) {
      const source = contents.toString('utf8')
      rewritten.set(file, rewriteSource(source, file, sourceRoot, id, (name) => dependencies.add(name)))
      if (/\.[jt]sx$/.test(file)) dependencies.add('react')
    }
  }
  const peers = {}
  const runtime = {}
  for (const name of [...dependencies].sort()) {
    const declared = app.manifest.dependencies?.[name] ?? app.manifest.devDependencies?.[name] ?? app.manifest.peerDependencies?.[name]
    if (declared && /^(?:workspace:|file:|link:|portal:|patch:|git\+|https?:|github:)/.test(declared)) throw new Error(`Dependency ${name} uses a local/Git locator. Publish that dependency first and install its npm version.`)
    const version = installedVersion(app, name)
    if (!/^\d+\.\d+\.\d+/.test(version || '')) throw new Error(`Invalid installed version for ${name}.`)
    const singleton = name.startsWith('@open-mercato/') || name.startsWith('@mikro-orm/') || ['react', 'react-dom', 'next'].includes(name)
    ;(singleton ? peers : runtime)[name] = version
  }
  if (fs.existsSync(destination)) throw new Error(`Export directory already exists: ${destination}`)
  fs.mkdirSync(destination, { recursive: true })
  for (const file of files) {
    const output = path.join(destination, 'src/modules', id, path.relative(sourceRoot, file))
    fs.mkdirSync(path.dirname(output), { recursive: true })
    if (rewritten.has(file)) fs.writeFileSync(output, rewritten.get(file))
    else fs.copyFileSync(file, output)
  }
  const typescriptVersion = require('typescript/package.json').version
  const manifest = {
    name: settings.packageName, version: settings.version,
    description: `Open Mercato module: ${id}`,
    license: app.manifest.license || 'UNLICENSED', type: 'module',
    main: './dist/index.js',
    files: ['src', 'dist', 'build.cjs', 'README.md'],
    exports: {
      '.': { types: './src/index.ts', default: './dist/index.js' },
      './package.json': './package.json',
      './*.json': './dist/*.json',
      './*.ts': { types: './src/*.ts', default: './dist/*.js' },
      './*.tsx': { types: './src/*.tsx', default: './dist/*.js' },
      './*': { types: ['./src/*.ts', './src/*.tsx'], default: './dist/*.js' },
    },
    scripts: { build: 'node build.cjs', prepack: 'npm run build' },
    engines: { node: '>=24' },
    ...(Object.keys(runtime).length ? { dependencies: runtime } : {}),
    peerDependencies: peers,
    devDependencies: { typescript: typescriptVersion, ...peers },
    publishConfig: { access: settings.access },
    ...(settings.repository ? { repository: { type: 'git', url: `git+https://github.com/${settings.repository}.git` } } : {}),
    mercatoModule: { id, formatVersion: 1 },
  }
  writeJson(path.join(destination, 'package.json'), manifest)
  fs.writeFileSync(path.join(destination, 'src/index.ts'), `export { metadata } from './modules/${id}/index.js'\n`)
  fs.copyFileSync(path.join(__dirname, 'build.cjs'), path.join(destination, 'build.cjs'))
  fs.writeFileSync(path.join(destination, '.gitignore'), 'node_modules/\n*.tgz\n.env*\n.npmrc\n')
  fs.writeFileSync(path.join(destination, 'README.md'), `# ${settings.packageName}\n\nInstall in an Open Mercato app:\n\n\`\`\`sh\nyarn mercato module add ${settings.packageName} --allow-third-party\n\`\`\`\n\nThis repository is a snapshot of module \`${id}\` from its source application.\nDevelop in the source application and publish a new version with create-mercato-module.\n`)
  build(destination)
  return { destination, manifest, fileCount: files.length }
}

module.exports = { validateSettings, installedVersion, preparePackage }
