import type {
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from 'node:child_process'
import type { DevelopmentLink } from './development.js'

export interface PackageManifest {
  name?: string
  version?: string
  description?: string
  keywords?: string[]
  license?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  scripts?: Record<string, string>
  repository?: { type: string; url: string }
  homepage?: string
  bugs?: { url: string }
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
  // SPDX expression or UNLICENSED; unset keeps the module or app license.
  license?: string
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
  description: string
  keywords: string[]
  mercatoModule: { id: string; formatVersion: number }
}

export interface PreparedPackage {
  destination: string
  manifest: GeneratedManifest
  fileCount: number
  // No setting, module metadata, app or repository names a license, so the
  // package falls back to UNLICENSED.
  licenseDefaulted?: boolean
}

export interface ExportedPackage extends PreparedPackage {
  workspace: string
  archive: string
  integrity: string
  linkedCheckout?: string
  linkedFingerprint?: string
  linkedBranch?: string
  installScripts?: string[]
  notes?: string[]
  // Shown with a warning sign in the publish summary.
  warnings?: string[]
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
