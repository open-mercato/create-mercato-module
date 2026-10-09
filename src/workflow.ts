export function createPublishWorkflow(access: 'public' | 'restricted'): string {
  return `name: Publish module to npm

on:
  workflow_dispatch:
  push:
    tags: ['v*']

permissions:
  contents: read
  id-token: write

concurrency:
  group: npm-publish
  cancel-in-progress: false

jobs:
  publish:
    # Manual runs publish only from the default branch; tags publish their own commit.
    if: github.ref_type == 'tag' || github.ref_name == github.event.repository.default_branch
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: '24'
          registry-url: https://registry.npmjs.org
          package-manager-cache: false
      - name: Install dependencies
        run: |
          if [ -f package-lock.json ]; then npm ci --ignore-scripts; else npm install --ignore-scripts; fi
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_READ_TOKEN }}
      - name: Check release tag
        run: node -e 'const manifest = require("./package.json"); if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== "v" + manifest.version) throw new Error("Tag must match package.json version")'
      - run: npm run build
      - name: Publish with npm Trusted Publishing
        run: |
          TAG=latest
          if node -e "process.exit(require('./package.json').version.includes('-') ? 0 : 1)"; then TAG=next; fi
          npm publish --access ${access} --tag "$TAG" --ignore-scripts
`
}
