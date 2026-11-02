import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fixture } from "./fixture.js";

for (const mode of ["legacy", "modern"] as const) {
  test(`stdio CLI supports ${mode} MCP discovery and calls without stdout logging`, async () => {
    const f = await fixture();
    await writeFile(
      join(f.directory, "accounts.json"),
      JSON.stringify({ accounts: [{ id: "a" }] }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        resolve("dist/cli.js"),
        "serve",
        "--config",
        join(f.directory, "accounts.json"),
        "--data-dir",
        join(f.directory, "stdio-data"),
      ],
      stderr: "pipe",
    });
    const client = new Client(
      { name: "fixture-client", version: "1.0.0" },
      { versionNegotiation: { mode: mode === "modern" ? { pin: "2026-07-28" } : "legacy" } },
    );
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 17);
      assert.ok(tools.tools.some((t) => t.name === "login_account"));
      assert.ok(tools.tools.some((t) => t.name === "send_message"));
      assert.ok(!tools.tools.some((t) => /evaluate|execute|browser/.test(t.name)));
      const result = await client.callTool({ name: "list_accounts", arguments: {} });
      assert.equal(result.isError, undefined);
      assert.ok(JSON.stringify(result).includes('"accountId":"a"'));
      const unknown = await client.callTool({
        name: "login_account",
        arguments: { accountId: "missing" },
      });
      assert.equal(unknown.isError, true);
      assert.ok(JSON.stringify(unknown).includes("UNKNOWN_ACCOUNT"));
      const staged = await client.callTool({
        name: "stage_attachment",
        arguments: {
          accountId: "a",
          source: {
            type: "base64",
            filename: "example.txt",
            data: Buffer.from("synthetic resource").toString("base64"),
          },
        },
      });
      const metadata = staged.structuredContent as { data: { resourceUri: string } };
      const resource = await client.readResource({ uri: metadata.data.resourceUri });
      const content = resource.contents[0];
      assert.ok(content && "blob" in content);
      assert.equal(Buffer.from(content.blob as string, "base64").toString(), "synthetic resource");
      const blocked = await client.callTool({
        name: "send_message",
        arguments: {
          accountId: "a",
          conversationId: "201",
          text: "Never send",
          requestId: "blocked-request",
        },
      });
      assert.equal(blocked.isError, true);
      assert.ok(JSON.stringify(blocked).includes("READ_ONLY"));
    } finally {
      await client.close();
      await f.close();
    }
  });
}

test("CLI rejects network transports and removed browser-helper commands", async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.directory, "accounts.json"),
      JSON.stringify({ accounts: [{ id: "a" }] }),
    );
    for (const [args, expected] of [
      [["serve", "--transport", "http"], "UNSUPPORTED_TRANSPORT"],
      [["serve", "--transport", "sse"], "UNSUPPORTED_TRANSPORT"],
      [["login-host"], "INVALID_ARGUMENT"],
    ] as const) {
      const result = spawnSync(
        process.execPath,
        [resolve("dist/cli.js"), ...args, "--config", join(f.directory, "accounts.json")],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.includes(expected));
    }
  } finally {
    await f.close();
  }
});
