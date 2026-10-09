<p align="center"><img src="https://raw.githubusercontent.com/open-mercato/create-mercato-module/main/.github/readme/open-mercato.svg" alt="Open Mercato logo" width="72" /></p>

<h1 align="center">Create Mercato Module</h1>

<p align="center"><strong>Build in your app. Publish one module.</strong></p>

<p align="center">Turn a custom Open Mercato module into an npm package and a dedicated GitHub repository.<br />Two commands. From your terminal or an Open Mercato Cloud sandbox.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/create-mercato-module"><img src="https://img.shields.io/npm/v/create-mercato-module?color=b4f372&amp;label=npm" alt="npm version" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%E2%89%A524-1b1b1b" alt="Node.js 24 or newer" /></a>
  <a href="https://github.com/open-mercato/create-mercato-module/actions/workflows/test.yml"><img src="https://github.com/open-mercato/create-mercato-module/actions/workflows/test.yml/badge.svg" alt="Tests" /></a>
  <a href="https://github.com/open-mercato/create-mercato-module/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-bc9aff" alt="MIT license" /></a>
</p>

```bash
npx create-mercato-module init visits
# Build your feature in src/modules/visits.
npx create-mercato-module publish visits
```

Your application is the development workspace. This tool creates a portable package from **one selected module**, including its sources, compiled code, translations, and migrations. Publish it to npm, optionally give it a dedicated GitHub repository, and install it in another Open Mercato app.

**Already built the module?** Skip `init` and go straight to [`publish`](#publish-an-existing-module).

<p align="center"><a href="#quick-start">Quick start</a> · <a href="#publish-an-existing-module">Existing modules</a> · <a href="#in-an-open-mercato-cloud-sandbox">Cloud sandboxes</a> · <a href="#preview-before-you-publish">Dry run</a> · <a href="docs/guide.md#command-reference">Commands</a> · <a href="https://docs.openmercato.com/">Docs</a> · <a href="https://discord.gg/f4qwPtJ3qA">Discord</a></p>

<p align="center"><img src="https://raw.githubusercontent.com/open-mercato/create-mercato-module/main/.github/readme/module-flow.svg" alt="Develop visits in your Open Mercato app, package only that module, then publish to npm and an optional dedicated GitHub repository." width="100%" /></p>

## Quick start

You need **Node.js 24+, Yarn 4, and Docker**. On Windows, use WSL2. Already inside an installed app or Cloud sandbox? Skip step 1.

### 1. Create an Open Mercato app

```bash
npx create-mercato-app@develop my-app --preset empty
cd my-app
cp .env.example .env
docker compose up -d
yarn install
```

Follow the scaffold prompts to choose your AI coding tools. The `develop` channel provides the framework version used for this tool's standalone installation checks. See the [Open Mercato installation guide](https://docs.openmercato.com/installation) for setup details.

### 2. Create and build your module

```bash
npx create-mercato-module init visits
yarn setup
```

`init` creates `src/modules/visits`, registers it as `@app`, and runs generation. `yarn setup` initializes your new app and starts its development server; leave it running. Open `/backend/visits` using the app credentials printed in the terminal, then build your feature in `src/modules/visits`.

If your app is already initialized and running, use only `init` and continue with its existing dev server.

### 3. Publish your module

Open another terminal in the app directory:

```bash
cd my-app
npm login
gh auth login # only if you want a dedicated GitHub repository
npx create-mercato-module publish visits
```

The wizard asks for the npm package name, version, optional GitHub repository, and public or restricted access. It builds an archive, shows the destinations, and asks you to confirm. Complete npm's 2FA verification when requested.

Settings are remembered in `.mercato/module-tool.json`; later releases reuse them and default to the next stable patch version. Use `--configure` to change them. Your app's module, other modules, and Git origin stay in place.

### 4. Install it in another app

Once npm makes the published version available, run inside the receiving app:

```bash
yarn mercato module add @your-name/mercato-visits --allow-third-party
```

## Publish an existing module

If `src/modules/visits/index.ts` already exists, publish it directly:

```bash
npx create-mercato-module publish visits \
  --package @your-name/mercato-visits \
  --repo your-name/mercato-visits
```

Keep developing locally and run the same command for later releases. The app can have its own Git repository or no Git repository at all.

## Develop in a dedicated repository

After publishing, connect the module repository to your current app:

```bash
npx create-mercato-module link visits
```

The tool clones the repository under `.mercato`, backs up your original source, and links `src/modules/visits` to the checkout. Keep editing and running the same app; those edits now belong to the module repository.

This link is local: a fresh clone of the whole app needs the module source restored or linked again. See [repository development and PR workflow](docs/guide.md#develop-in-the-dedicated-repository-without-leaving-your-app) for details.

## In an Open Mercato Cloud sandbox

The sandbox already contains an installed app. From its terminal in `/workspace`:

```bash
npx create-mercato-module init visits
npx create-mercato-module publish visits
```

The app keeps its repository while the selected module gets its own package and optional repository.

## Preview before you publish

```bash
npx create-mercato-module publish visits \
  --package @your-name/mercato-visits \
  --dry-run
```

This builds a real `.tgz` under `.mercato/module-publish/`, without login or publication. See the [command reference](docs/guide.md#command-reference) for repository, version, access, and automation options.

## Documentation

| Topic | Guide |
|---|---|
| Commands and flags | [Command reference](docs/guide.md#command-reference) |
| Login and npm tokens | [Authentication](docs/guide.md#authentication) |
| GitHub Actions without a write token | [Trusted Publishing](docs/guide.md#npm-trusted-publishing) |
| Contents, dependencies, and portable imports | [Package contents](docs/guide.md#what-ships-in-the-package) |
| Errors mentioning `.mercato/generated` | [Generated-import errors](docs/guide.md#an-error-mentions-mercatogenerated) |
| Settings, Git, and releases | [Release behavior](docs/guide.md#how-git-and-releases-work) |
| Run the unreleased GitHub version | [GitHub installation](docs/guide.md#try-the-github-version) |
| Contribute and run checks | [Development](docs/guide.md#development) |
| Verify clean app installs from npm and GitHub | [Release tests](https://github.com/open-mercato/create-mercato-module/blob/main/test/release-e2e/README.md) |

---

Part of [Open Mercato](https://github.com/open-mercato/open-mercato). [Website](https://openmercato.com/) · [Framework docs](https://docs.openmercato.com/) · [Cloud](https://openmercatocloud.com/) · [Discord](https://discord.gg/f4qwPtJ3qA)

MIT © Open Mercato contributors. See [LICENSE](LICENSE).
