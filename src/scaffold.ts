import type { App } from './types.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as ts from 'typescript'
import { validateId } from './common.js'

function registration(source: string, id: string): string {
  const parsed = ts.createSourceFile(
    'modules.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  let list: ts.ArrayLiteralExpression | undefined
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(parsed) === 'enabledModules' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      list = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  if (!list)
    throw new Error(
      'Expected an enabledModules array in src/modules.ts. Register the module manually if this app uses a custom configuration.',
    )
  for (const element of list.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue
    const property = element.properties.find(
      (entry) =>
        ts.isPropertyAssignment(entry) &&
        entry.name.getText(parsed).replace(/['"]/g, '') === 'id',
    )
    if (
      property &&
      ts.isPropertyAssignment(property) &&
      ts.isStringLiteral(property.initializer) &&
      property.initializer.text === id
    ) {
      throw new Error(
        `Module ${id} is already registered. Choose another name.`,
      )
    }
  }
  const offset = list.end - 1
  const comma =
    list.elements.length && !list.elements.hasTrailingComma ? ',' : ''
  return `${source.slice(0, offset)}${comma}\n  { id: '${id}', from: '@app' },\n${source.slice(offset)}`
}

function scaffold(app: App, id: string): string {
  validateId(id)
  const destination = path.join(app.directory, 'src/modules', id)
  if (fs.existsSync(destination))
    throw new Error(
      `src/modules/${id} already exists. Use publish to package an existing module.`,
    )
  const modulesFile = path.join(app.directory, 'src/modules.ts')
  for (const target of [
    path.join(app.directory, 'src'),
    path.join(app.directory, 'src/modules'),
    modulesFile,
  ]) {
    if (fs.existsSync(target) && fs.realpathSync(target) !== target)
      throw new Error(
        'Module sources and src/modules.ts must not use symlinks.',
      )
  }
  const source = fs.readFileSync(modulesFile, 'utf8')
  const updated = registration(source, id)
  const title = id
    .split('_')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
  const files = {
    'index.ts': `import type { ModuleInfo } from '@open-mercato/shared/modules/registry'\n\nexport const metadata: ModuleInfo = {\n  name: '${id}',\n  title: '${title}',\n  version: '0.1.0',\n  ejectable: true,\n}\n`,
    [`backend/${id}/page.tsx`]: `import { Page, PageBody } from '@open-mercato/ui/backend/Page'\nimport { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'\n\nexport default async function ModulePage() {\n  const { t } = await resolveTranslations()\n  return (\n    <Page>\n      <PageBody>\n        <h1 className="text-2xl font-semibold">{t('${id}.title')}</h1>\n        <p className="text-muted-foreground">{t('${id}.welcome')}</p>\n      </PageBody>\n    </Page>\n  )\n}\n`,
    [`backend/${id}/page.meta.ts`]: `import type { PageMetadata } from '@open-mercato/shared/modules/registry'\n\nexport const metadata: PageMetadata = {\n  requireAuth: true,\n  title: '${title}',\n  titleKey: '${id}.title',\n}\n`,
    'i18n/en.json': `${JSON.stringify({ [`${id}.title`]: title, [`${id}.welcome`]: 'Your module is ready. Start building here.' }, null, 2)}\n`,
    'i18n/pl.json': `${JSON.stringify({ [`${id}.title`]: title, [`${id}.welcome`]: 'Moduł jest gotowy. Tutaj możesz zacząć pracę.' }, null, 2)}\n`,
  }
  fs.mkdirSync(destination, { recursive: true })
  try {
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(destination, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, content, { flag: 'wx' })
    }
    fs.writeFileSync(modulesFile, updated)
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true })
    throw error
  }
  return destination
}

export { registration, scaffold }
