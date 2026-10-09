import fs from 'node:fs'
import path from 'node:path'
import type { App, Config, SavedSettings, Settings } from './types.js'
import type { DevelopmentLink } from './development.js'
import { validateId } from './common.js'

function exists(file: string): boolean {
  try {
    fs.lstatSync(file)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false
    throw error
  }
}

function metadataFile(app: App, create = false): string {
  const root = fs.realpathSync(app.directory)
  const directory = path.join(root, '.mercato')
  if (!exists(directory) && create) fs.mkdirSync(directory)
  if (
    exists(directory) &&
    (!fs.lstatSync(directory).isDirectory() ||
      fs.lstatSync(directory).isSymbolicLink())
  ) {
    throw new Error(
      '📁 The app .mercato folder must be a real directory. Metadata cannot be read or saved through a symlink.',
    )
  }
  return path.join(directory, 'module-tool.json')
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function developmentLink(value: unknown): DevelopmentLink {
  if (!record(value) || value.formatVersion !== 1)
    throw new Error('Invalid saved module development link.')
  const keys = [
    'repository',
    'packageName',
    'checkoutPath',
    'sourcePath',
    'backupPath',
  ] as const
  for (const key of keys) {
    if (typeof value[key] !== 'string')
      throw new Error(`Invalid saved development ${key}.`)
  }
  return {
    formatVersion: 1,
    repository: String(value.repository),
    packageName: String(value.packageName),
    checkoutPath: String(value.checkoutPath),
    sourcePath: String(value.sourcePath),
    backupPath: String(value.backupPath),
  }
}

function settingsFrom(value: unknown): SavedSettings {
  if (!record(value))
    throw new Error(
      'Invalid saved module settings. Expected a settings object.',
    )
  const output: SavedSettings = {
    packageName: '',
    version: '0.1.0',
    access: 'public',
  }
  const keys = [
    'packageName',
    'version',
    'access',
    'repository',
    'auth',
    'tag',
    'lastPublishedVersion',
    'lastReleaseCommit',
  ] as const
  for (const key of keys) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'string')
      throw new Error(`Invalid saved module ${key}. Expected text.`)
    output[key] = value[key]
  }
  if (value.development !== undefined)
    output.development = developmentLink(value.development)
  return output
}

export function loadConfig(app: App): Config {
  const destination = metadataFile(app)
  const legacy = path.join(
    fs.realpathSync(app.directory),
    'mercato-modules.json',
  )
  const file = exists(destination) ? destination : legacy
  if (!exists(file))
    return { version: 1, modules: Object.create(null) as Config['modules'] }
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
    throw new Error(
      `📁 ${path.relative(app.directory, file)} must be a regular metadata file, not a symlink.`,
    )
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error(
      `Cannot read ${path.relative(app.directory, file)}. Fix its JSON syntax and retry.`,
    )
  }
  if (!record(value) || value.version !== 1 || !record(value.modules))
    throw new Error(
      `Invalid ${path.relative(app.directory, file)}. Expected version: 1 and a modules object.`,
    )
  const modules = Object.create(null) as Config['modules']
  for (const [id, settings] of Object.entries(value.modules)) {
    validateId(id)
    modules[id] = settingsFrom(settings)
  }
  return { version: 1, modules }
}

function writeConfig(app: App, config: Config): void {
  const destination = metadataFile(app, true)
  if (
    exists(destination) &&
    (!fs.lstatSync(destination).isFile() ||
      fs.lstatSync(destination).isSymbolicLink())
  )
    throw new Error(
      '📁 .mercato/module-tool.json must be a regular file, not a symlink.',
    )
  const temporary = path.join(
    path.dirname(destination),
    `.module-tool-${process.pid}-${Date.now()}.json`,
  )
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    fs.renameSync(temporary, destination)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

export function saveConfig(
  app: App,
  id: string,
  settings: Settings,
  published: boolean,
): void {
  validateId(id)
  const config = loadConfig(app)
  const previous = config.modules[id]
  config.modules[id] = settingsFrom({
    ...settings,
    ...(previous?.lastPublishedVersion
      ? { lastPublishedVersion: previous.lastPublishedVersion }
      : {}),
    ...(previous?.lastReleaseCommit
      ? { lastReleaseCommit: previous.lastReleaseCommit }
      : {}),
    ...(previous?.development ? { development: previous.development } : {}),
    ...(published ? { lastPublishedVersion: settings.version } : {}),
  })
  writeConfig(app, config)
}

export function saveDevelopment(
  app: App,
  id: string,
  development: DevelopmentLink,
  settings: Settings,
): void {
  saveConfig(app, id, settings, false)
  const config = loadConfig(app)
  config.modules[id].development = developmentLink(development)
  writeConfig(app, config)
}

export function saveReleaseCommit(app: App, id: string, commit: string): void {
  validateId(id)
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return
  const config = loadConfig(app)
  if (!config.modules[id]) return
  config.modules[id].lastReleaseCommit = commit
  writeConfig(app, config)
}
