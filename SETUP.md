# Local setup for Codex and Claude Code

The MCP runs directly on your desktop as a local stdio subprocess. Codex or
Claude Code starts it when connecting and stops it when disconnecting. Your
client must stay connected while using tools or completing login. You do not
need to start a background server or a second login process.

## 1. Install locally

Requirements: Node.js 24+, pnpm 10.32.1, a desktop session, and Codex CLI or Claude
Code installed. Open a terminal in the cloned repository and run this on Windows,
macOS or Linux:

```sh
node scripts/setup-local.mjs
```

On macOS/Linux, `make setup` runs the same command. Setup installs dependencies
from the committed lockfile, installs Playwright Chromium and builds the project.
It creates `.env` and `accounts.json` only when absent. Existing configuration,
credentials and sessions are preserved. Review the aliases in `accounts.json`,
such as `personal`, and keep `WG_MCP_READ_ONLY=true` in `.env` during setup.

For a manual installation:

```sh
pnpm install --frozen-lockfile
pnpm browsers:install
pnpm build
node scripts/setup-local.mjs --config-only
```

The MCP uses its own isolated browser profiles. It does not reuse or close your
ordinary Chrome tabs. To use installed Google Chrome instead of bundled Chromium,
set `WG_MCP_BROWSER_CHANNEL=chrome` in `.env`.

## 2. Register with Codex CLI

From the repository root on macOS/Linux:

```sh
codex mcp add wg-gesucht -- "$(command -v node)" \
  "$PWD/dist/cli.js" serve --env-file "$PWD/.env"
codex mcp list
```

On Windows (PowerShell):

```powershell
$nodeExecutable = (Get-Command node).Source
$mcpScript = (Resolve-Path .\dist\cli.js).Path
$envFile = (Resolve-Path .\.env).Path
codex mcp add wg-gesucht -- $nodeExecutable $mcpScript serve --env-file $envFile
codex mcp list
```

Restart Codex or reconnect the MCP after registration. You can instead add this
entry to your private Codex configuration, replacing the example paths with
absolute paths on your machine:

```toml
[mcp_servers.wg-gesucht]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/wg-gesucht-mcp/dist/cli.js", "serve", "--env-file", "/absolute/path/to/wg-gesucht-mcp/.env"]
startup_timeout_sec = 20
tool_timeout_sec = 90
```

Windows TOML paths can use forward slashes, for example `C:/Projects/wg-gesucht-mcp`.
The command and argument setup follows the [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## 3. Register with Claude Code

From the repository root on macOS/Linux:

```sh
claude mcp add --transport stdio wg-gesucht -- "$(command -v node)" \
  "$PWD/dist/cli.js" serve --env-file "$PWD/.env"
claude mcp list
```

On Windows (PowerShell):

```powershell
$nodeExecutable = (Get-Command node).Source
$mcpScript = (Resolve-Path .\dist\cli.js).Path
$envFile = (Resolve-Path .\.env).Path
claude mcp add --transport stdio wg-gesucht -- $nodeExecutable $mcpScript serve --env-file $envFile
claude mcp list
```

Restart Claude Code, then use `/mcp` to inspect the connection. The default scope
is local to the current project. Add `--scope user` before the server name if you
want the registration available across projects. Alternatively, use a private
JSON configuration:

```json
{
  "mcpServers": {
    "wg-gesucht": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/wg-gesucht-mcp/dist/cli.js",
        "serve",
        "--env-file",
        "/absolute/path/to/wg-gesucht-mcp/.env"
      ]
    }
  }
}
```

See the [official Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

## 4. Sign in through the MCP tool

Ask Codex or Claude Code:

> Call `login_account` for account `personal` to open the local login wizard.
> Let me sign in in the browser, then check `get_account_status`. Do not change
> any website data.

The tool input is:

```json
{ "accountId": "personal" }
```

The MCP opens a visible browser directly on your desktop. Complete login, CAPTCHA
or 2FA yourself. When authentication is detected, it saves the session privately
and closes that browser window automatically. Later reads reuse the session in
a headless browser. No password or cookie is returned to the agent.

`login_account` returns immediately to avoid a client timeout while you sign in.
Poll `get_account_status` with the same account ID. Its `login.state` progresses
through `opening_browser`, `waiting_for_login`, `saving_session` and finally
`authenticated`. Closing the window produces `cancelled`; failures produce
`failed`; an expired deadline produces `timed_out`. The default deadline is five
minutes; optional `timeoutSeconds` accepts 60–600.

Repeating the tool during an active wizard returns its existing login ID. Other
browser operations on that account return `LOGIN_IN_PROGRESS`; other accounts
remain available. Login works with `WG_MCP_READ_ONLY=true`. The session persists
in `.data/accounts/<accountId>/` across client restarts.

Once signed in, ask the agent to list your own advertisements for `personal`.
Saved sessions can expire; use `login_account` again when `LOGIN_REQUIRED` appears.

## 5. Replace an older installation

Replace any earlier WG-Gesucht URL-based registration with the local command above.
List your existing registrations and remove the obsolete entry by its registered
name before adding the new entry. For example, if its name is `wg-gesucht-docker`:

```sh
codex mcp remove wg-gesucht-docker
# Or, for Claude Code:
claude mcp remove wg-gesucht-docker
```

Stop an old Compose service from Docker Desktop if it is still running. Keep its
data volume and private session backups until you have verified the local login.
Existing native sessions under `.data/accounts/` remain usable. A local session
backup can be restored with the CLI import command in [README.md](README.md#local-commands).
Obsolete token/port settings in an existing `.env` are ignored and can be removed;
setup preserves your existing file.

## Development with Docker Desktop

Docker is optional for isolated builds and synthetic tests. Start Docker Desktop
and run the same command in PowerShell, bash or zsh:

```sh
docker compose run --rm --build check
```

On macOS/Linux, `make docker-check` is equivalent. This runs the automated checks
in an ephemeral non-root container using synthetic accounts. It mounts no private
configuration, profiles or credentials and exposes no ports. For the visible
login wizard, use the native MCP registration above.

## Troubleshooting

- **Tool missing:** Rebuild with `pnpm build` and restart the MCP connection. Check
  `codex mcp list` or `claude mcp list` and the absolute Node/script/env-file paths.
- **`LOGIN_BROWSER_UNAVAILABLE`:** Run the MCP directly in a desktop session.
  Install Chromium with `pnpm browsers:install`, or select installed Chrome in
  `.env`. On Windows, run the client natively to open a Windows desktop window.
- **`ACCOUNT_BUSY`:** Another local process owns this account profile. Disconnect
  that client's MCP before using it elsewhere. A crashed lock expires after about
  30 seconds. Different accounts have separate locks and queues.
- **`LOGIN_REQUIRED`:** Call `login_account`, complete login and poll account status.
- **`READ_ONLY`:** Saves, uploads and sending require explicitly setting
  `WG_MCP_READ_ONLY=false` and restarting the MCP. Reading a conversation can mark
  it read on WG-Gesucht even with this guard enabled.

For configuration and browser diagnostics:

```sh
node dist/cli.js doctor --env-file .env
```
