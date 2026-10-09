const fs = require('node:fs')
const path = require('node:path')
const { readJson, writeJson, run, within } = require('./common.cjs')
const { preparePackage } = require('./package.cjs')

function exportPackage(app, id, settings) {
  const root = path.join(app.directory, '.mercato/module-publish')
  fs.mkdirSync(root, { recursive: true })
  if (!within(app.directory, fs.realpathSync(root))) throw new Error('The .mercato export directory must remain inside the application.')
  const workspace = fs.mkdtempSync(path.join(root, `${id}-`))
  const result = preparePackage(app, id, settings, path.join(workspace, 'package'))
  const packed = run('npm', ['pack', '--json', '--ignore-scripts'], result.destination, { capture: true })
  const entries = JSON.parse(packed.stdout)
  if (entries.length !== 1 || !entries[0].filename || path.basename(entries[0].filename) !== entries[0].filename) throw new Error('npm pack did not produce one package archive.')
  for (const file of entries[0].files) {
    if (!/^(?:src\/|dist\/|package\.json$|build\.cjs$|README\.md$|LICENSE$)/.test(file.path)) throw new Error(`Unexpected file in npm package: ${file.path}`)
  }
  return { ...result, workspace, archive: path.join(result.destination, entries[0].filename), integrity: entries[0].integrity }
}

function githubState(repository, cwd, execute = run) {
  const result = execute('gh', ['api', `repos/${repository}`], cwd, { capture: true, allowFailure: true })
  if (result.status === 0) return 'exists'
  if (/HTTP 404/.test(result.stderr || '')) return 'missing'
  throw new Error('Cannot inspect the GitHub repository. Check gh auth login and network access; no repository was created.')
}

function publishRepository(prepared, settings, execute = run) {
  const state = githubState(settings.repository, prepared.workspace, execute)
  if (state === 'missing') execute('gh', ['repo', 'create', settings.repository, settings.access === 'public' ? '--public' : '--private', '--description', `Open Mercato module: ${prepared.manifest.mercatoModule.id}`], prepared.workspace)
  const checkout = path.join(prepared.workspace, 'repository')
  execute('gh', ['repo', 'clone', settings.repository, checkout], prepared.workspace)
  const gitRoot = execute('git', ['rev-parse', '--show-toplevel'], checkout, { capture: true }).stdout.trim()
  if (fs.realpathSync(gitRoot) !== fs.realpathSync(checkout)) throw new Error('Refusing to use the application repository for module publication.')
  const hasHead = execute('git', ['rev-parse', '--verify', 'HEAD'], checkout, { capture: true, allowFailure: true }).status === 0
  if (hasHead) {
    const packageFile = path.join(checkout, 'package.json')
    if (!fs.existsSync(packageFile) || fs.lstatSync(packageFile).isSymbolicLink()) throw new Error('The GitHub repository is not a package created by this tool. Choose a new repository.')
    const manifest = readJson(packageFile)
    if (manifest.name !== settings.packageName || manifest.mercatoModule?.id !== prepared.manifest.mercatoModule.id || manifest.mercatoModule?.formatVersion !== 1) throw new Error('The GitHub repository belongs to another package/module. Choose a different repository.')
  } else execute('git', ['checkout', '-b', 'main'], checkout)
  const identity = execute('git', ['var', 'GIT_AUTHOR_IDENT'], checkout, { capture: true, allowFailure: true })
  if (identity.status !== 0) {
    const user = JSON.parse(execute('gh', ['api', 'user'], checkout, { capture: true }).stdout)
    if (!/^[a-zA-Z0-9-]+$/.test(user.login) || !Number.isSafeInteger(user.id)) throw new Error('GitHub returned an invalid author identity.')
    execute('git', ['config', 'user.name', user.login], checkout)
    execute('git', ['config', 'user.email', `${user.id}+${user.login}@users.noreply.github.com`], checkout)
  }
  const owned = ['src', 'dist', 'package.json', 'build.cjs', 'README.md', '.gitignore']
  for (const name of owned) {
    const destination = path.join(checkout, name)
    fs.rmSync(destination, { recursive: true, force: true })
    fs.cpSync(path.join(prepared.destination, name), destination, { recursive: true })
  }
  execute('git', ['add', '--', ...owned], checkout)
  if (execute('git', ['diff', '--cached', '--quiet'], checkout, { capture: true, allowFailure: true }).status !== 0) {
    execute('git', ['commit', '-m', `Release ${settings.packageName}@${settings.version}`], checkout)
  }
  execute('git', ['push', '-u', 'origin', 'HEAD'], checkout)
}

function preflight(prepared, settings, execute = run) {
  if (execute('npm', ['whoami'], prepared.destination, { capture: true, allowFailure: true }).status !== 0) throw new Error('Log in with npm login, then run publish again. No external changes were made.')
  const version = execute('npm', ['view', `${settings.packageName}@${settings.version}`, 'version', '--json'], prepared.destination, { capture: true, allowFailure: true })
  if (version.status === 0 && version.stdout.trim()) throw new Error('This npm version is already published. Choose a new --version.')
  if (version.status !== 0 && !/E404/.test(`${version.stdout}\n${version.stderr}`)) throw new Error('Cannot verify the npm version. Check registry/network access and retry.')
  if (settings.repository && execute('gh', ['auth', 'status'], prepared.workspace, { capture: true, allowFailure: true }).status !== 0) throw new Error('Log in with gh auth login, then run publish again. No external changes were made.')
}

function publish(prepared, settings, execute = run) {
  preflight(prepared, settings, execute)
  if (settings.repository) publishRepository(prepared, settings, execute)
  execute('npm', ['publish', prepared.archive, '--access', settings.access, '--ignore-scripts'], prepared.destination)
}

function loadConfig(app) {
  const file = path.join(app.directory, 'mercato-modules.json')
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('mercato-modules.json must not be a symlink.')
  if (!fs.existsSync(file)) return { version: 1, modules: {} }
  const config = readJson(file)
  if (config.version !== 1 || !config.modules || typeof config.modules !== 'object' || Array.isArray(config.modules)) throw new Error('Invalid mercato-modules.json. Expected version: 1 and a modules object.')
  return config
}

function saveConfig(app, id, settings, published) {
  const config = loadConfig(app)
  config.modules[id] = { ...settings, ...(published ? { lastPublishedVersion: settings.version } : {}) }
  writeJson(path.join(app.directory, 'mercato-modules.json'), config)
}

module.exports = { exportPackage, githubState, publishRepository, preflight, publish, loadConfig, saveConfig }
