const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { scaffold } = require('../dist/scaffold.js')
const { writeJson, readJson, run } = require('../dist/common.js')
const { exportPackage } = require('../dist/publish.js')

test('packed module installs and is discovered by the real standalone Mercato CLI, including eject', { skip: !process.env.OPEN_MERCATO_ROOT }, (context) => {
  const framework = fs.realpathSync(process.env.OPEN_MERCATO_ROOT)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-real-cli-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const version = readJson(path.join(framework, 'packages/core/package.json')).version
  function linkPackages(directory) {
    fs.mkdirSync(path.join(directory, 'node_modules'), { recursive: true })
    for (const name of fs.readdirSync(path.join(framework, 'node_modules'))) {
      const target = path.join(directory, 'node_modules', name)
      if (name === '@open-mercato') {
        fs.mkdirSync(target, { recursive: true })
        for (const packageName of fs.readdirSync(path.join(framework, 'node_modules', name))) {
          const packageRoot = path.join(target, packageName)
          const sourceRoot = path.join(framework, 'node_modules', name, packageName)
          if (packageName !== 'core') fs.symlinkSync(sourceRoot, packageRoot)
          else {
            fs.mkdirSync(packageRoot, { recursive: true })
            for (const entry of fs.readdirSync(sourceRoot)) fs.symlinkSync(path.join(sourceRoot, entry), path.join(packageRoot, entry))
          }
        }
        continue
      }
      if (!fs.existsSync(target)) fs.symlinkSync(path.join(framework, 'node_modules', name), target)
    }
  }
  function app(name) {
    const directory = path.join(root, name)
    const manifest = { name, private: true, dependencies: { '@open-mercato/core': version, '@open-mercato/shared': version, '@open-mercato/ui': version } }
    writeJson(path.join(directory, 'package.json'), manifest)
    fs.mkdirSync(path.join(directory, 'src/modules'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'src/modules.ts'), 'export const enabledModules = []\n')
    fs.writeFileSync(path.join(directory, 'next.config.ts'), 'export default {}\n')
    return { directory, manifest }
  }
  const source = app('source-app')
  linkPackages(source.directory)
  scaffold(source, 'visits')
  const prepared = exportPackage(source, 'visits', { packageName: '@fixture/visits', version: '0.1.0', repository: '', access: 'public' })
  const consumer = app('consumer-app')
  writeJson(path.join(consumer.directory, 'package.json'), { name: 'consumer-app', private: true })
  run('npm', ['install', prepared.archive, '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], consumer.directory, { capture: true })
  const installed = readJson(path.join(consumer.directory, 'package.json'))
  writeJson(path.join(consumer.directory, 'package.json'), { ...installed, dependencies: { ...consumer.manifest.dependencies, ...installed.dependencies } })
  linkPackages(consumer.directory)
  const cli = path.join(framework, 'packages/cli/dist/bin.js')
  const enabled = run(process.execPath, [cli, 'module', 'enable', '@fixture/visits', '--allow-third-party'], consumer.directory, { capture: true, allowFailure: true })
  assert.equal(enabled.status, 0, `${enabled.stdout}\n${enabled.stderr}`)
  assert.match(enabled.stdout, /enabled from @fixture\/visits/)
  assert.match(fs.readFileSync(path.join(consumer.directory, 'src/modules.ts'), 'utf8'), /@fixture\/visits/)
  const registries = fs.readdirSync(path.join(consumer.directory, '.mercato/generated')).filter((name) => name.endsWith('.ts'))
    .map((name) => fs.readFileSync(path.join(consumer.directory, '.mercato/generated', name), 'utf8')).join('\n')
  assert.match(registries, /@fixture\/visits\/modules\/visits\/backend\/visits\/page/)
  assert.match(registries, /@fixture\/visits\/modules\/visits\/i18n\/en.json/)
  fs.writeFileSync(path.join(consumer.directory, 'src/modules.ts'), 'export const enabledModules = []\n')
  run(process.execPath, [cli, 'module', 'enable', '@fixture/visits', '--allow-third-party', '--eject'], consumer.directory, { capture: true })
  assert.ok(fs.existsSync(path.join(consumer.directory, 'src/modules/visits/backend/visits/page.tsx')))
  assert.match(fs.readFileSync(path.join(consumer.directory, 'src/modules.ts'), 'utf8'), /from: ['"]@app['"]/)
})
