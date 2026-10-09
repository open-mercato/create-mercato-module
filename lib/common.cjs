const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function within(root, file) {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function validateId(id) {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(id || '')) {
    throw new Error('Use a module name in snake_case, for example customer_visits.')
  }
  return id
}

function findApp(start = process.cwd()) {
  let directory = fs.realpathSync(start)
  while (true) {
    const manifest = path.join(directory, 'package.json')
    if (fs.existsSync(manifest) && fs.existsSync(path.join(directory, 'src/modules.ts'))) {
      const app = readJson(manifest)
      if (app.dependencies?.['@open-mercato/core']) return { directory, manifest: app }
    }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error('Run this command inside a create-mercato-app application.')
    directory = parent
  }
}

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    ...options,
  })
  if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}`)
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} failed (exit ${result.status ?? 'signal'}). Fix the reported error and retry.`)
  }
  return result
}

function moduleDirectory(app, id) {
  validateId(id)
  const root = path.join(app.directory, 'src/modules')
  const directory = path.join(root, id)
  if (!fs.existsSync(path.join(directory, 'index.ts'))) throw new Error(`No local module at src/modules/${id}/index.ts.`)
  if (!within(root, fs.realpathSync(directory)) || fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error('The module must be a real directory inside src/modules.')
  }
  return directory
}

module.exports = { readJson, writeJson, within, validateId, findApp, run, moduleDirectory }
