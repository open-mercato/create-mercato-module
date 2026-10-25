import type { App } from './types.js'
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
  moduleInfo,
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
}

/**
 * Prints the Open Mercato Modules entry of a published module from saved
 * settings and the module's `metadata`, without network access.
 */
export function describeModule(app: App, id: string): ModuleDescription {
  const saved = loadConfig(app).modules[id]
  if (!saved?.packageName)
    throw new Error(
      `Module ${id} has no saved npm package. Publish it first: npx create-mercato-module publish ${id}`,
    )
  if (saved.access === 'restricted')
    throw new Error(
      `${saved.packageName} is a restricted npm package. Open Mercato Modules lists public packages only.`,
    )
  const source = saved.development
    ? linkedModuleDirectory(app, id, saved.development)
    : moduleDirectory(app, id)
  const info = moduleInfo(source)
  // A linked repository's own package.json description wins, as in publish.
  let description = info.description
  if (saved.development) {
    const manifest = path.join(
      app.directory,
      saved.development.checkoutPath,
      'package.json',
    )
    const own = fs.existsSync(manifest) ? readJson(manifest).description : ''
    if (typeof own === 'string' && own.trim() && own !== `Open Mercato module: ${id}`)
      description = own.replace(/\s+/g, ' ').trim()
  }
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
