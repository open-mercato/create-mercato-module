#!/usr/bin/env node
// Stand-in for the GitHub CLI during local release checks. It answers the few
// commands the tool runs from bare repositories under RELEASE_E2E_GITHUB_ROOT
// and refuses everything else, so no request can reach github.com.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.env.RELEASE_E2E_GITHUB_ROOT
const args = process.argv.slice(2)

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function repository(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name ?? '')) fail(`gh shim: invalid repository ${name}`)
  return path.join(root, `${name}.git`)
}

function git(gitArgs, cwd) {
  const result = spawnSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) fail('gh shim: RELEASE_E2E_GITHUB_ROOT must be an existing absolute directory')

if (args[0] === 'auth' && args[1] === 'status') process.exit(0)

if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write(JSON.stringify({ login: 'release-checks', id: 1 }))
  process.exit(0)
}

const contents = args[0] === 'api' ? /^repos\/([^/]+\/[^/]+)\/contents\/package\.json$/.exec(args[1] ?? '') : null
if (contents) {
  const directory = repository(contents[1])
  if (!fs.existsSync(directory)) fail('gh: Not Found (HTTP 404)')
  const file = git(['show', 'main:package.json'], directory)
  if (file.status !== 0) fail('gh: Not Found (HTTP 404)')
  process.stdout.write(file.stdout)
  process.exit(0)
}

const api = args[0] === 'api' ? /^repos\/([^/]+\/[^/]+)(?:\/commits\/(.+))?$/.exec(args[1] ?? '') : null
if (api) {
  const directory = repository(api[1])
  if (!fs.existsSync(directory)) fail('gh: Not Found (HTTP 404)')
  if (!api[2]) {
    const details = JSON.parse(fs.readFileSync(`${directory}.json`, 'utf8'))
    process.stdout.write(JSON.stringify({ private: details.private, default_branch: 'main' }))
    process.exit(0)
  }
  const ref = decodeURIComponent(api[2])
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)) fail(`gh shim: invalid ref ${ref}`)
  const sha = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], directory)
  if (sha.status !== 0) fail('gh: Git Repository is empty. (HTTP 409)')
  const message = git(['log', '-1', '--format=%B', sha.stdout.trim()], directory).stdout.replace(/\n+$/, '')
  const jq = args[args.indexOf('--jq') + 1]
  if (!args.includes('--jq')) process.stdout.write(JSON.stringify({ sha: sha.stdout.trim(), commit: { message } }))
  else if (jq === '.sha') process.stdout.write(`${sha.stdout.trim()}\n`)
  else if (jq === '[.sha, .commit.message] | @json') process.stdout.write(`${JSON.stringify([sha.stdout.trim(), message])}\n`)
  else fail(`gh shim: unsupported --jq ${jq}`)
  process.exit(0)
}

if (args[0] === 'repo' && args[1] === 'create') {
  const directory = repository(args[2])
  if (fs.existsSync(directory)) fail('gh shim: repository already exists')
  if (!args.includes('--public') && !args.includes('--private')) fail('gh shim: repo create needs --public or --private')
  fs.mkdirSync(path.dirname(directory), { recursive: true })
  const created = git(['init', '--bare', '--initial-branch=main', directory], root)
  if (created.status !== 0) fail(created.stderr)
  fs.writeFileSync(`${directory}.json`, JSON.stringify({ private: args.includes('--private') }))
  process.exit(0)
}

if (args[0] === 'repo' && args[1] === 'clone' && args[3]) {
  const directory = repository(args[2])
  if (!fs.existsSync(directory)) fail('gh: Not Found (HTTP 404)')
  const cloned = git(['clone', directory, args[3]], process.cwd())
  if (cloned.status === 0) {
    // Keep GitHub identity for validation; route pushes to the local bare repo.
    git(['remote', 'set-url', 'origin', `https://github.com/${args[2]}.git`], args[3])
    git(['remote', 'set-url', '--push', 'origin', directory], args[3])
  }
  process.stderr.write(cloned.stderr)
  process.exit(cloned.status ?? 1)
}

fail(`gh shim: refusing unsupported command: gh ${args.join(' ')}`)
