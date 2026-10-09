import type {
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from 'node:child_process'
import type { DevelopmentLink } from './development.js'

export interface PackageManifest {
  name?: string
  version?: string
  license?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  scripts?: Record<string, string>
  repository?: { type: string; url: string }
  mercatoModule?: { id: string; formatVersion: number }
}

export interface App {
  directory: string
  manifest: PackageManifest
}

export interface Settings {
  packageName: string
  version: string
  access: string
  repository?: string
  auth?: string
  tag?: string
}

export interface SavedSettings extends Settings {
  lastPublishedVersion?: string
  development?: DevelopmentLink
}

export interface Config {
  version: 1
  modules: Record<string, SavedSettings>
}

export interface GeneratedManifest extends PackageManifest {
  name: string
  version: string
  mercatoModule: { id: string; formatVersion: number }
}

export interface PreparedPackage {
  destination: string
  manifest: GeneratedManifest
  fileCount: number
}

export interface ExportedPackage extends PreparedPackage {
  workspace: string
  archive: string
  integrity: string
  linkedCheckout?: string
  linkedFingerprint?: string
}

export type RunOptions = Omit<
  SpawnSyncOptionsWithStringEncoding,
  'encoding'
> & {
  capture?: boolean
  allowFailure?: boolean
}

export type Executor = (
  command: string,
  args: string[],
  cwd: string,
  options?: RunOptions,
) => SpawnSyncReturns<string>
