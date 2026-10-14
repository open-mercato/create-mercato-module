const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync, spawn } = require('node:child_process')
const { clearTimeout } = require('node:timers')
const { writeJson } = require('../dist/common.js')
const { parse } = require('../dist/cli.js')
const commit = '0123456789abcdef0123456789abcdef01234567'

function fixture(context, options = {}) {
  const commits = options.commits ?? {}
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mercato-install-cli-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const app = path.join(root, 'app')
  const binary = path.join(root, 'bin')
  const calls = path.join(root, 'calls.jsonl')
  fs.mkdirSync(path.join(app, 'src'), { recursive: true })
  fs.mkdirSync(path.join(app, 'node_modules/@open-mercato/core'), {
    recursive: true,
  })
  fs.mkdirSync(binary)
  writeJson(path.join(app, 'package.json'), {
    name: 'fixture-app',
    dependencies: { '@open-mercato/core': '0.9.0' },
  })
  writeJson(path.join(app, 'node_modules/@open-mercato/core/package.json'), {
    name: '@open-mercato/core',
    version: '0.9.0',
  })
  fs.writeFileSync(
    path.join(app, 'src/modules.ts'),
    'export const enabledModules = []\n',
  )
  fs.writeFileSync(
    path.join(binary, 'yarn'),
    `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({command:'yarn',args})+'\\n');\n` + (options.blocked ? `const approvedFile=${JSON.stringify(path.join(root, 'approved.json'))};if(args[0]==='add'&&!fs.existsSync(approvedFile)){console.error("YN0080: Request to 'https://github.com/fixture-owner/visits-example.git' blocked by approvedGitRepositories");process.exit(1)}if(args[0]==='config'&&args[1]==='get')console.log(JSON.stringify(['https://github.com/open-mercato/*']));if(args[0]==='config'&&args[1]==='set')fs.writeFileSync(approvedFile,args.at(-1));\n` : ''),
    { mode: 0o755 },
  )
  fs.writeFileSync(
    path.join(binary, 'gh'),
    `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({command:'gh',args:a})+'\\n');if(a[0]==='auth')process.exit(0);if(a[1]==='user'){console.log(JSON.stringify({login:'fixture-owner'}));process.exit(0)}if(a[1]?.includes('/commits/')){const refs=${JSON.stringify(commits)};const ref=decodeURIComponent(a[1].split('/commits/')[1]);if(refs[ref]===null){console.error('gh: No commit found for SHA: '+ref+' (HTTP 422)');process.exit(1)}console.log(refs[ref]||${JSON.stringify(commit)});process.exit(0)}if(a[1]?.includes('/contents/package.json')){console.log(JSON.stringify({name:'@fixture/visits',version:'1.2.3',mercatoModule:{id:'visits',formatVersion:1}}));process.exit(0)}if(a[1]?.startsWith('repos/')){console.log(JSON.stringify({private:false,default_branch:'main'}));process.exit(0)}process.exit(1)\n`,
    { mode: 0o755 },
  )
  const cli = (args) => {
    const result = spawnSync(
      process.execPath,
      [path.resolve(__dirname, '../bin/cli.cjs'), ...args],
      {
        cwd: app,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binary}${path.delimiter}${process.env.PATH}`,
        },
      },
    )
    return { ...result, output: `${result.stdout}\n${result.stderr}` }
  }
  const readCalls = () =>
    fs
      .readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse)
  const interactive = (answer) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', `Object.defineProperty(process.stdin, 'isTTY', {value:true});require(${JSON.stringify(path.resolve(__dirname, '../dist/cli.js'))}).main(['install','fixture-owner/visits-example']).catch(error=>{console.error(error.message);process.exitCode=1})`], {
      cwd: app,
      env: { ...process.env, PATH: `${binary}${path.delimiter}${process.env.PATH}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    let answered = false
    const timer = setTimeout(() => { child.kill(); reject(new Error('Interactive approval timed out')) }, 15000)
    child.stdout.on('data', data => {
      output += data
      if (!answered && output.includes('[y/N]')) {
        answered = true
        child.stdin.write(`${answer}\n`)
      }
    })
    child.stderr.on('data', data => { output += data })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', status => { clearTimeout(timer); resolve({status, output}) })
  })
  return { cli, readCalls, interactive }
}

test('install CLI accepts npm and GitHub locators end to end', (context) => {
  const { cli, readCalls } = fixture(context)
  const npm = cli([
    'install',
    '@fixture/visits@beta',
    '--module',
    'visits',
    '--eject',
  ])
  assert.equal(npm.status, 0, npm.output)
  assert.match(npm.output, /Installed @fixture\/visits/)
  assert.deepEqual(readCalls().at(-1), {
    command: 'yarn',
    args: [
      'mercato',
      'module',
      'add',
      '@fixture/visits@beta',
      '--allow-third-party',
      '--module',
      'visits',
      '--eject',
    ],
  })

  const github = cli(['install', 'visits-example', '--ref', 'v1.2.3'])
  assert.equal(github.status, 0, github.output)
  assert.match(github.output, /Source: fixture-owner\/visits-example/)
  assert.ok(
    readCalls().some(
      ({ command, args }) =>
        command === 'gh' &&
        args[1] ===
          'repos/fixture-owner/visits-example/commits/v1.2.3',
    ),
  )
  assert.deepEqual(readCalls().slice(-2), [
    {
      command: 'yarn',
      args: ['add', `@fixture/visits@github:fixture-owner/visits-example#${commit}`],
    },
    {
      command: 'yarn',
      args: [
        'mercato',
        'module',
        'enable',
        '@fixture/visits',
        '--allow-third-party',
      ],
    },
  ])
})

test('install CLI resolves npm-style GitHub versions before calling Yarn', (context) => {
  const selectedCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const { cli, readCalls } = fixture(context, { commits: { '1.2.3': null, 'v1.2.3': selectedCommit } })
  const result = cli(['install', 'fixture-owner/visits-example@1.2.3', '--module', 'visits', '--eject'])
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /Installed @fixture\/visits/)
  assert.deepEqual(
    readCalls().filter(call => call.args[1]?.includes('/commits/')).map(call => call.args[1]),
    ['repos/fixture-owner/visits-example/commits/1.2.3', 'repos/fixture-owner/visits-example/commits/v1.2.3'],
  )
  assert.deepEqual(readCalls().slice(-2), [
    { command: 'yarn', args: ['add', `@fixture/visits@github:fixture-owner/visits-example#${selectedCommit}`] },
    { command: 'yarn', args: ['mercato', 'module', 'enable', '@fixture/visits', '--allow-third-party', '--module', 'visits', '--eject'] },
  ])
})

test('install CLI fails a missing version without invoking Yarn', (context) => {
  const { cli, readCalls } = fixture(context, { commits: { '1.2.3': null, 'v1.2.3': null } })
  const result = cli(['install', 'fixture-owner/visits-example@1.2.3'])
  assert.notEqual(result.status, 0)
  assert.match(result.output, /Cannot resolve.*No files were changed/)
  assert.equal(readCalls().some(call => call.command === 'yarn'), false)
})

test('install CLI parsing validates options and locator arity', () => {
  assert.equal(parse(['install', 'owner/repository', '--approve-git-repository']).flags['approve-git-repository'], true)
  assert.deepEqual(
    parse([
      'install',
      'owner/repository',
      '--package',
      '@fixture/visits',
      '--module',
      'visits',
      '--ref',
      'v1.2.3',
      '--eject',
    ]),
    {
      command: 'install',
      id: 'owner/repository',
      flags: {
        package: '@fixture/visits',
        module: 'visits',
        ref: 'v1.2.3',
        eject: true,
      },
    },
  )
  assert.throws(
    () => parse(['install', 'owner/repository', 'another']),
    /Too many arguments/,
  )
  assert.throws(
    () => parse(['install', 'owner/repository', '--module', '../escape']),
    /snake_case/,
  )
})

test('install CLI explains Yarn approval and requires its own flag without a terminal', (context) => {
  const { cli, readCalls } = fixture(context, { blocked: true })
  const denied = cli(['install', 'fixture-owner/visits-example'])
  assert.equal(denied.status, 1, denied.output)
  assert.match(denied.output, /🔒 Yarn blocked/)
  assert.match(denied.output, /https:\/\/github.com\/fixture-owner\/visits-example.git/)
  assert.match(denied.output, /--approve-git-repository/)
  assert.ok(!readCalls().some(call => call.args[0] === 'config'))
  const approved = cli(['install', 'fixture-owner/visits-example', '--approve-git-repository'])
  assert.equal(approved.status, 0, approved.output)
  const set = readCalls().find(call => call.args[0] === 'config' && call.args[1] === 'set')
  assert.deepEqual(JSON.parse(set.args.at(-1)), ['https://github.com/open-mercato/*', 'https://github.com/fixture-owner/visits-example.git'])
  assert.match(approved.output, /Installed @fixture\/visits/)
})

test('interactive installer writes Yarn approval only after an affirmative answer', async (context) => {
  for (const answer of ['yes', 'no', '']) {
    const { interactive, readCalls } = fixture(context, { blocked: true })
    const result = await interactive(answer)
    assert.match(result.output, /Add this repository to Yarn approvals and retry\? \[y\/N\]/)
    const sets = readCalls().filter(call => call.args[0] === 'config' && call.args[1] === 'set')
    if (answer === 'yes') {
      assert.equal(result.status, 0, result.output)
      assert.equal(sets.length, 1)
      assert.match(result.output, /Installed @fixture\/visits/)
    } else {
      assert.equal(result.status, 1, result.output)
      assert.equal(sets.length, 0)
      assert.match(result.output, /Yarn approvals were not changed/)
    }
  }
})
