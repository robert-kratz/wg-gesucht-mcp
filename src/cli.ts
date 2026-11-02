#!/usr/bin/env node
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { chromium } from "playwright";
import { loadConfig } from "./config.js";
import { AppError, publicError } from "./errors.js";
import { createServer } from "./mcp.js";
import { WgGesucht } from "./site.js";

const help = `wg-gesucht-mcp — multi-account WG-Gesucht browser bridge

Commands:
  serve [--transport stdio]          Run locally; the MCP client manages this process
  login --account ID                 Open a visible browser; save login immediately
  accounts                          Show local account/session metadata
  status --account ID [--check]      Optionally verify login with a read-only request
  doctor                            Check configuration, browser availability and write mode
  session export --account ID --output PATH
  session import --account ID --input PATH

Common options:
  --config PATH     Accounts configuration (default: accounts.json)
  --env-file PATH   Load a private .env file; inherited environment takes precedence
  --data-dir PATH   Override persistent data directory
  --help           Show help

Use the login_account MCP tool to open the local browser login wizard.
Writes are disabled unless WG_MCP_READ_ONLY=false.
Never put passwords or tokens in command-line arguments.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "env-file": { type: "string" },
      "data-dir": { type: "string" },
      transport: { type: "string", default: "stdio" },
      account: { type: "string" },
      input: { type: "string" },
      output: { type: "string" },
      check: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  const command = positionals[0] || "serve";
  if (values.transport !== "stdio")
    throw new AppError(
      "UNSUPPORTED_TRANSPORT",
      "This MCP runs locally over stdio. Register its Node.js command in your MCP client.",
    );
  const config = await loadConfig({
    config: values.config,
    envFile: values["env-file"],
    dataDir: values["data-dir"],
  });
  const site = new WgGesucht(config);
  const print = (data: unknown) => process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  const requireOption = (value: string | undefined, option: string) => {
    if (!value) throw new AppError("INVALID_ARGUMENT", `--${option} is required.`);
    return value;
  };
  let stopTransport: (() => Promise<void>) | undefined;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await stopTransport?.();
    await site.browsers.close();
  };
  process.once("SIGINT", () => {
    void shutdown().finally(() => {
      process.exitCode = 0;
    });
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => {
      process.exitCode = 0;
    });
  });
  if (command === "serve") {
    const handle = serveStdio(() => createServer(site), {
      transport: new StdioServerTransport(process.stdin, process.stdout, {
        maxBufferSize: 15 * 1024 * 1024,
      }),
      onerror: () => process.stderr.write("MCP stdio transport error.\n"),
    });
    stopTransport = () => handle.close();
    process.stdin.once("end", () => {
      void shutdown();
    });
    return;
  }
  try {
    if (command === "accounts")
      print({
        accounts: await Promise.all(config.accounts.map((a) => site.browsers.status(a.id))),
      });
    else if (command === "status") {
      const accountId = requireOption(values.account, "account");
      if (values.check) await site.getProfile(accountId);
      print({
        ...(await site.browsers.status(accountId)),
        ...(values.check ? { authenticated: true } : {}),
      });
    } else if (command === "login") {
      process.stderr.write(
        "Complete login in the visible browser. CAPTCHA/2FA remain manual. Waiting up to five minutes.\n",
      );
      await site.browsers.login(requireOption(values.account, "account"));
      print({ authenticated: true, accountId: values.account });
    } else if (command === "session" && positionals[1] === "export") {
      const output = requireOption(values.output, "output");
      await site.browsers.exportSession(requireOption(values.account, "account"), output);
      print({
        exported: true,
        path: resolve(output),
        note: "Treat this file like a password. Transfer it privately and delete transfer copies.",
      });
    } else if (command === "session" && positionals[1] === "import") {
      await site.browsers.importSession(
        requireOption(values.account, "account"),
        requireOption(values.input, "input"),
      );
      print({ imported: true, accountId: values.account });
    } else if (command === "doctor") {
      const executable =
        config.browserChannel === "chromium" ? chromium.executablePath() : undefined;
      print({
        node: process.version,
        accounts: config.accounts.map((a) => a.id),
        browserChannel: config.browserChannel,
        bundledBrowserInstalled: executable
          ? await access(executable).then(
              () => true,
              () => false,
            )
          : null,
        dataDirectory: config.dataDir,
        readOnly: config.readOnly,
        transport: "stdio",
        note: "Use login_account in your MCP client for the local browser wizard. Use pnpm browsers:install for Chromium. --check on status verifies website authentication. No passwords or sessions are printed.",
      });
    } else throw new AppError("INVALID_ARGUMENT", "Unknown command. Use --help.");
  } finally {
    await shutdown();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
  process.exitCode = 1;
});
