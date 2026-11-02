# Contributing

Use Node.js 24+ and pnpm 10.32.1. Install with `pnpm install --frozen-lockfile`,
then `pnpm browsers:install`. Run `pnpm check` before proposing a change.
`pnpm format` applies repository formatting.

The GitHub Actions workflow runs on pushes to `main`, pull requests and manual
dispatch. It checks formatting, linting, types and the build first, then runs the
synthetic test suite in an isolated non-root Docker container. Dependencies are
installed from the lockfile; the workflow has read-only repository permissions.

To run the same workflow locally, install [act](https://nektosact.com/installation/index.html),
start Docker Desktop or Docker Engine, and run:

```sh
node scripts/test-ci.mjs
# Or on macOS/Linux:
make ci-local
```

The helper selects the runner architecture and supplies empty environment,
secret, variable and input files so act never loads the private `.env`. Git-ignored
profiles and credentials are excluded from the runner copy and Docker context.
The first run may download the runner image and public actions. act emulates the
Linux workflow; GitHub-hosted runner and permission behavior can still differ.

All documentation, comments, errors, and tool descriptions use English. Keep
browser selectors in the adapters and validate inputs before touching a form.
Changes to a write adapter need a synthetic browser fixture covering its behavior,
verification, and failure handling. No test may contact the live website.

Keep Playwright's package and installed browser revision aligned. The Docker
image installs browsers using the exact pinned package. Update the MCP packages
together and check both current and legacy clients.

Never commit real sessions, messages, account identifiers, HTML exports, cookies,
credentials, photos, or screenshots. Do not exercise writes against production
accounts. This project does not bypass login challenges or platform restrictions.

Public npm/image releases and marketplace registration are separate maintainer
actions. The repository intentionally has `private: true` to prevent accidental
npm publication; local builds and `pnpm pack` remain usable.
