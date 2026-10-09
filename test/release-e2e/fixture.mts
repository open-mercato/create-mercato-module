import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const fixtureContract = {
  moduleId: 'release_checks',
  marker: 'Mercato release fixture',
  page: 'backend/release_checks/page',
  api: 'api/status',
  entity: 'data/entities',
  entityExport: 'ReleaseCheck',
  translationKey: 'release_checks.title',
  asset: 'assets/fixture.txt',
}

export function writeFixture(appDirectory: string): void {
  const directory = path.join(appDirectory, 'src/modules', fixtureContract.moduleId)
  if (fs.existsSync(directory)) throw new Error(`Fixture module already exists: ${directory}`)
  const files: Record<string, string> = {
    'index.ts': `export const metadata = { name: 'release_checks', title: 'Release checks', version: '0.1.0', ejectable: true }\n`,
    'backend/release_checks/page.tsx': `'use client'\nimport { useState } from 'react'\nexport default function ReleaseChecks() { const [label] = useState('Mercato release fixture'); return <h1>{label}</h1> }\n`,
    'backend/release_checks/page.meta.ts': `export const metadata = { requireAuth: true, pageTitle: 'Release checks', pageTitleKey: 'release_checks.title' }\n`,
    'api/status.ts': `import { fields } from '../lib/fields'\nexport const metadata = { GET: { requireAuth: true } }\nexport async function GET() { return Response.json({ marker: 'Mercato release fixture', field: fields.status, entity: 'release_checks:release_check' }) }\n`,
    'lib/fields.ts': `export const fields = { status: 'status' } as const\n`,
    'data/entities.ts': `import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy'\n@Entity({ tableName: 'release_checks' })\nexport class ReleaseCheck {\n  @PrimaryKey({ type: 'uuid' })\n  id!: string\n  @Property({ name: 'organization_id', type: 'uuid' })\n  organizationId!: string\n  @Property({ name: 'tenant_id', type: 'uuid' })\n  tenantId!: string\n  @Property({ type: 'text' })\n  status = 'draft'\n  @Property({ name: 'updated_at', type: 'Date' })\n  updatedAt: Date = new Date()\n}\n`,
    'i18n/en.json': JSON.stringify({ 'release_checks.title': fixtureContract.marker }, null, 2) + '\n',
    'i18n/pl.json': JSON.stringify({ 'release_checks.title': 'Test wydania Mercato' }, null, 2) + '\n',
    'assets/fixture.txt': `${fixtureContract.marker}\n`,
    'migrations/.snapshot-open-mercato.json': '{}\n',
  }
  for (const [filename, contents] of Object.entries(files)) {
    const target = path.join(directory, filename)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, contents)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appDirectory = process.argv[2]
  if (!appDirectory) throw new Error('Usage: node test/release-e2e/fixture.mts /absolute/path/to/clean-app')
  writeFixture(path.resolve(appDirectory))
  process.stdout.write(JSON.stringify(fixtureContract, null, 2) + '\n')
}
