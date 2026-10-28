import type { App, SavedSettings } from './types.js'
import type { DevelopmentLink } from './development.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { moduleDirectory, readJson, run } from './common.js'
import { loadConfig } from './config.js'
import { linkedModuleDirectory } from './development.js'
import {
  catalogUrl,
  catalogOpen,
  catalogPendingNote,
  catalogSubmitUrl,
  fallbackDescription,
  moduleInfo,
  validatePackageName,
  validateRepositoryName,
} from './package.js'

// Categories of the Open Mercato Modules descriptor schema
// (https://modules.openmercato.com/schema/descriptor-1.json).
const categories = [
  'crm-sales',
  'catalog-pricing',
  'orders-checkout',
  'warehouse-shipping',
  'payments-finance',
  'marketing-loyalty',
  'communication',
  'integrations-sync',
  'ai-automation',
  'search-analytics',
  'auth-security',
  'content-portal',
  'localization-compliance',
  'storage-infrastructure',
  'devtools',
  'operations',
]

// The catalog accepts only plain text: no links, markdown, HTML, control
// characters or long dashes.
const notPlainText =
  // eslint-disable-next-line no-control-regex
  /https?:\/\/|www\.|[[\]`<>]|(?:^|\s)\*|^\s*#|[\u0000-\u001f\u007f-\u009f\u2013\u2014]/i

function plainText(value: string | undefined, min: number, max: number) {
  return value !== undefined &&
    value.length >= min &&
    value.length <= max &&
    !notPlainText.test(value)
    ? value
    : undefined
}

/**
 * Why a module description cannot be the catalog summary (20 to 140
 * characters of plain text), or undefined when it can.
 */
export function descriptionProblem(value: string): string | undefined {
  if (value.length < 20 || value.length > 140)
    return `Write 20 to 140 characters (this has ${value.length}).`
  if (notPlainText.test(value))
    return 'Write plain text: no links, markdown, HTML, control characters or long dashes.'
  return undefined
}

/**
 * The description npm and the catalog get for a module, as publish builds it:
 * a linked repository's own package.json description wins over the metadata,
 * unless it is empty or the fallback its first export wrote. `file` names
 * where the author sets it.
 */
export function moduleDescription(
  app: App,
  id: string,
  development?: DevelopmentLink,
): { description?: string; file: string } {
  const source = development
    ? linkedModuleDirectory(app, id, development)
    : moduleDirectory(app, id)
  if (development) {
    const manifest = path.join(
      app.directory,
      development.checkoutPath,
      'package.json',
    )
    const own = fs.existsSync(manifest) ? readJson(manifest).description : ''
    if (typeof own === 'string' && own.trim() && own !== fallbackDescription(id))
      return {
        description: own.replace(/\s+/g, ' ').trim(),
        file: `${development.checkoutPath}/package.json`,
      }
  }
  const description = moduleInfo(source).description
  return {
    ...(description ? { description } : {}),
    file: `the metadata in ${development ? `${development.checkoutPath}/` : ''}src/modules/${id}/index.ts`,
  }
}

/**
 * The warning for a missing description or, for a module listed in the
 * catalog, one that cannot be its summary; undefined when it is usable.
 */
export function descriptionWarning(
  id: string,
  description: string | undefined,
  file: string,
  listed = true,
): string | undefined {
  const missing = !description || description === fallbackDescription(id)
  const problem = !missing && listed ? descriptionProblem(description) : undefined
  if (!missing && !problem) return undefined
  return `⚠️ ${missing ? `Module ${id} has no description.` : `The description of ${id} cannot be the catalog summary: ${problem}`} Set description in ${file} (one sentence, 20 to 140 characters): it becomes ${listed ? 'the catalog summary and ' : ''}the npm description of the next version you publish.`
}

// Plain when YAML reads it back unchanged, otherwise double quotes; the
// catalog's formatter writes scalars the same way.
function scalar(value: string): string {
  return /^[-?:,[\]{}#&*!|>'"%@`]|: |:$| #|^(?:true|false|null|~)$|^[-+]?(?:\.?\d|0x|0o|\.inf|\.nan)/i.test(
    value,
  ) || value !== value.trim()
    ? JSON.stringify(value)
    : value
}

export interface ModuleDescription {
  packageName: string
  yaml: string
  submitUrl: string
  // Set when the module has no description the catalog can use as summary.
  warning?: string
}

/**
 * Prints the Open Mercato Modules entry of a module from saved settings, or
 * the package named by `packageName` before the first release, and the
 * module's `metadata`, without network access.
 */
export function describeModule(
  app: App,
  id: string,
  packageName?: string,
): ModuleDescription {
  if (packageName !== undefined) validatePackageName(packageName)
  const stored = loadConfig(app).modules[id]
  // Saved settings of another package (repository, link) do not apply.
  const saved: Partial<SavedSettings> | undefined =
    packageName && stored?.packageName !== packageName
      ? { packageName, access: 'public' }
      : stored
  if (!saved?.packageName)
    throw new Error(
      `Module ${id} has no saved npm package. Publish it first: npx create-mercato-module publish ${id}\nOr name the package it will be published as: npx create-mercato-module describe ${id} --package @your-name/mercato-visits`,
    )
  // Saved settings may be edited by hand; they reach the output and --open.
  validatePackageName(saved.packageName)
  if (saved.repository) validateRepositoryName(saved.repository)
  if (saved.access === 'restricted')
    throw new Error(
      `${saved.packageName} is a restricted npm package. Open Mercato Modules lists public packages only.`,
    )
  const source = saved.development
    ? linkedModuleDirectory(app, id, saved.development)
    : moduleDirectory(app, id)
  const info = moduleInfo(source)
  const { description, file } = moduleDescription(app, id, saved.development)
  const title =
    plainText(info.title, 1, 60) ??
    id
      .split('_')
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join(' ')
  const summary = plainText(description, 20, 140)
  const lines = [
    `# Open Mercato Modules entry for ${saved.packageName}, as modules/${saved.packageName}.yml.`,
    '# Write each value marked TODO, then delete those TODO comments (the catalog rejects a file that still has them).',
    '# Submit the module at',
    `# ${catalogSubmitUrl(saved.packageName)}`,
    ...(catalogOpen ? [] : [`# ${catalogPendingNote}`]),
    ...(saved.lastPublishedVersion || saved.development
      ? []
      : [
          '# Publish the package to npm before you submit: the catalog reads it from npm.',
        ]),
    '',
    `npm: ${scalar(saved.packageName)}`,
    ...(saved.repository ? [`github: ${scalar(saved.repository)}`] : []),
    `# Categories: ${categories.join(', ')}`,
    'category: operations # choose the category that fits',
    summary
      ? `summary: ${scalar(summary)}`
      : `summary: ${scalar(`${title} module for Open Mercato apps.`)} # TODO: what it adds, 20 to 140 characters`,
    `whenToUse: ${scalar(`Use when an Open Mercato app needs the ${title} module.`)} # TODO: when an app needs it, 40 to 240 characters`,
  ]
  return {
    packageName: saved.packageName,
    yaml: `${lines.join('\n')}\n`,
    submitUrl: catalogSubmitUrl(saved.packageName),
    warning: descriptionWarning(id, description, file),
  }
}

/** Opens a catalog page in the default browser; false when that failed. */
export function openCatalogPage(url: string): boolean {
  if (!url.startsWith(`${catalogUrl}/`)) return false
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'explorer'
        : 'xdg-open'
  try {
    return (
      run(command, [url], process.cwd(), {
        capture: true,
        allowFailure: true,
      }).status === 0
    )
  } catch {
    return false
  }
}
