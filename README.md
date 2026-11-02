# WG-Gesucht MCP

A local MCP server connecting Codex CLI, Claude Code and other desktop MCP clients
to WG-Gesucht through Playwright. One operator can configure multiple accounts,
each with its own browser profile, persisted session and operation queue.

The MCP client launches this program as a local stdio subprocess. The
`login_account` tool opens a visible browser on your desktop for manual login,
saves the authenticated session and closes the window automatically. Subsequent
operations reuse the session. The default is `WG_MCP_READ_ONLY=true`.

## Quick start

Install Node.js 24+ and pnpm 10.32.1. From the cloned repository, on Windows,
macOS or Linux:

```sh
node scripts/setup-local.mjs
```

Setup installs pinned dependencies, Chromium and the TypeScript build, and creates
private `.env` and `accounts.json` files when absent. Existing settings and
sessions are preserved. Edit account aliases in `accounts.json`, then register
with Codex CLI or Claude Code as described in [SETUP.md](SETUP.md).

After registration, ask your agent:

> Open the login wizard with `login_account` for account `personal`. Let me sign
> in in the browser, then check `get_account_status`. Do not change website data.

Complete CAPTCHA and 2FA yourself. Credentials never go through chat. The tool
returns immediately while you sign in; `get_account_status` exposes progress and
the result. The MCP must run on the same desktop where you want the window to
open. Codex and Claude Code manage its process; keep your client connected while
signing in. No separate service or login terminal is needed.

Client setup follows the official [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
and [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

## Accounts and optional ENV login

`accounts.json` contains stable local aliases and optional references to environment
variable names. See [accounts.example.json](accounts.example.json). Every
account-specific MCP tool requires `accountId`; there is no active global account.

For automatic login, set the referenced email/password variables in your private
`.env`. The visible `login_account` wizard works without credentials in `.env`.
A missing or expired session returns `LOGIN_REQUIRED`; call the wizard to sign in.
Browser profiles and saved authentication state live in `.data/accounts/<accountId>/`.
Sessions are saved during operations and survive process restarts.

Profile locks prevent concurrent processes from opening the same account. Close
one client's MCP connection before using that profile in another client. Separate
accounts can be used concurrently. A crashed lock expires after about 30 seconds.

Use `--config`, `--env-file` and `--data-dir` for explicit paths. Existing environment
variables override `.env` entries. Paths inside an env file are relative to that
file; explicit CLI paths are relative to the current directory. An env file is
loaded only when `--env-file` is supplied.

## Tools

| Tool                                                    | Purpose                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `login_account`                                         | Interactive browser login, automatic session save and window close |
| `list_accounts`, `get_account_status`                   | Local account/session metadata                                     |
| `list_own_listings`, `get_own_listing`                  | Owned advertisements, fields, options, photos                      |
| `update_own_listing`, `set_listing_status`              | Partial edits and activation/deactivation                          |
| `manage_listing_photos`                                 | Add, remove, caption, reorder photos                               |
| `get_profile`, `update_profile`, `update_profile_photo` | Ordinary profile/contact details and image                         |
| `list_conversations`, `get_conversation`                | Inbox, message history and attachment metadata                     |
| `send_message`, `start_conversation`                    | Reply or contact a specified advertisement                         |
| `stage_attachment`, `download_attachment`               | Local file handles and received files                              |

Read tools return the website's English form field keys, values and allowed
select options. Pass only fields to change in `patch`; omitted values stay intact.
For example, a listing patch can contain `ad_title`, `rent_costs`,
`freetext_property_description`, or `freetext_area_description`. Dates use the
website's separate `available_from_day`, `available_from_month`,
`available_from_year` and corresponding `available_to_*` fields. Numeric prices
use the units shown by the website, not cents. Different advertisement categories
can expose different fields; use the returned field metadata.

Writes require `WG_MCP_READ_ONLY=false` and restarting the server. Ownership is
checked before advertisement edits. Saves are reloaded for verification. A
verification/address dialog or changed layout produces an error instead of an
automatic retry. There are no account deletion, advertisement creation/deletion,
login credential changes, paid promotion, bulk messaging, or arbitrary browser
execution tools.

### Attachments and sending

Stage a file first. Staging stores bytes locally and does **not** upload them to
WG-Gesucht. A path source must be inside `WG_MCP_ATTACHMENT_ROOTS`; bounded Base64 input is also supported:

```json
{
  "accountId": "personal",
  "source": { "type": "path", "path": "/allowed/attachments/example.pdf" }
}
```

The returned `fileId` belongs to that account. Pass handles through `fileIds` when
sending. The local limit is **10 MiB per file**; the website can impose additional
type, storage, and subscription restrictions. Photos accept JPG, PNG or GIF.
Received attachments download into the same account's file store. Download redirects outside WG-Gesucht are rejected.
File metadata includes a `resourceUri`. MCP clients can read that resource to
retrieve the file bytes locally.

Selecting the website's upload input uploads the file immediately, before the
message is sent. A failed send can therefore leave files in its library. Existing
drafts or pre-attached documents prevent automated sending.

Every send requires a unique, stable `requestId`. Reusing a confirmed request
returns its stored result; reusing it with different contents is rejected. After
a timeout or connection failure, `SEND_OUTCOME_UNKNOWN` prevents a duplicate.
Inspect the conversation manually; **do not generate a new requestId to retry**.
The local journal is deliberately conservative, including crashes before send
confirmation. Keep it across restarts.
New-contact success is confirmed through the website's success panel. When that
panel provides no conversation ID, refresh the inbox to find the new conversation.

Inbox pagination uses `page`. History supports `limit` and `beforeMessageId` for
messages loaded in the website. Responses report the oldest loaded ID; they do
not claim that unloaded history is complete.

## Local commands

The preferred sign-in route is the `login_account` MCP tool. For diagnostics or
local session backups, CLI commands are also available:

```sh
node dist/cli.js accounts --env-file .env
node dist/cli.js doctor --env-file .env
node dist/cli.js status --env-file .env --account personal --check
node dist/cli.js login --env-file .env --account personal
node dist/cli.js session export --env-file .env --account personal --output personal.session.json
node dist/cli.js session import --env-file .env --account personal --input personal.session.json
```

Disconnect any MCP connection using that account before running CLI commands
that open its browser. Session exports contain credentials; keep backups private.

## Development and Docker checks

```sh
pnpm check
# Optional isolated checks in Docker Desktop / Docker Engine:
docker compose run --rm --build check
```

Docker Compose provides a synthetic test environment. For interactive desktop
use, register the native Node.js command from [SETUP.md](SETUP.md). The application
has no listening port, HTTP transport or network login broker.

Tests exercise account isolation, profile locks, the local login wizard, expired
sessions, pagination, partial saves, ownership, attachments, send deduplication,
and current/legacy MCP discovery over stdio. All browser writes target synthetic
local pages. CI runs formatting, linting, TypeScript checks and a build with Node.js
24, followed by the complete synthetic test suite in a non-root container. Run
`node scripts/test-ci.mjs` to execute the workflow locally with act and Docker;
see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and
[LICENSE](LICENSE). Repository installation does not require a published package
or image.
