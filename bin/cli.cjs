#!/usr/bin/env node
require('../dist/cli.js')
  .main()
  .catch((error) => {
    console.error(
      `\n❌ ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  })
