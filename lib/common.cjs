const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')

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
  const startingDirectory = directory
  while (true) {
    const manifest = path.join(directory, 'package.json')
    const modulesFile = path.join(directory, 'src/modules.ts')
    if (fs.existsSync(manifest) && fs.statSync(manifest).isFile() && fs.existsSync(modulesFile) && fs.statSync(modulesFile).isFile()) {
      const app = readJson(manifest)
      if (app.dependencies?.['@open-mercato/core']) {
        let installed = path.join(directory, 'node_modules/@open-mercato/core/package.json')
        if (!fs.existsSync(installed)) {
          try {
            const loader = createRequire(manifest)
            installed = loader.resolve('@open-mercato/core/package.json')
          } catch {
            try {
              let packageDirectory = path.dirname(createRequire(manifest).resolve('@open-mercato/core'))
              while (!fs.existsSync(path.join(packageDirectory, 'package.json'))) {
                const parent = path.dirname(packageDirectory)
                if (parent === packageDirectory) break
                packageDirectory = parent
              }
              installed = path.join(packageDirectory, 'package.json')
            } catch {}
          }
        }
        if (!fs.existsSync(installed) || readJson(installed).name !== '@open-mercato/core') {
          throw new Error(`Open Mercato app found, but its dependencies are not installed.\n\n  App: ${directory}\n\nRun yarn install in the app, then retry this command.\nThe tool needs the installed @open-mercato/core package before it can create or publish modules.`)
        }
        return { directory, manifest: app }
      }
    }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`No Open Mercato app found here.\n\n  Current directory: ${startingDirectory}\n\nRun this tool inside an existing create-mercato-app application (or one of its subdirectories):\n\n  cd /path/to/your-mercato-app\n  npx create-mercato-module init visits\n\nThe app must have src/modules.ts and @open-mercato/core in package.json.\nNeed an app first? Run npx create-mercato-app my-app, install its dependencies, then cd my-app.\n\nNo files were changed.`)
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
