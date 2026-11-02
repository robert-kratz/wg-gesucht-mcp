import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { type BrowserContext, chromium } from "playwright";
import { BrowserManager } from "../src/browser.js";
import type { Config } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { createServer } from "../src/mcp.js";
import { WgGesucht } from "../src/site.js";
import { fixture } from "./fixture.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail("Timed out waiting for synthetic login state");
}

function testBrowser(config: Config) {
  const contexts: BrowserContext[] = [];
  const launches: boolean[] = [];
  const browsers = new BrowserManager(config, async (directory, options) => {
    launches.push(options?.headless ?? true);
    // Exercise real pages headlessly in CI; verify production requests a visible window.
    const context = await chromium.launchPersistentContext(directory, {
      ...options,
      headless: true,
    });
    contexts.push(context);
    return context;
  });
  return { browsers, contexts, launches };
}

async function signIn(context: BrowserContext, accountId: string) {
  const page = context.pages()[0];
  assert.ok(page);
  await page.locator("#pre_session_email").fill(`${accountId}@example.test`);
  await page.locator("#pre_session_form button").click();
  await page.locator("#login_password").fill("synthetic");
  await page.locator("#login_form button").click();
}

test("MCP login opens a separate visible window, saves, closes and reuses the session", async () => {
  const f = await fixture();
  const config = { ...f.config, env: {}, readOnly: true };
  const { browsers, contexts, launches } = testBrowser(config);
  const site = new WgGesucht(config, browsers);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = serveStdio(() => createServer(site), { transport: serverTransport });
  const client = new Client({ name: "login-fixture", version: "1" });
  try {
    await assert.rejects(site.getProfile("a"), code("LOGIN_REQUIRED"));
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "login_account", arguments: { accountId: "a" } });
    assert.equal(result.isError, undefined);
    assert.equal(
      (result.structuredContent as { data: { state: string } }).data.state,
      "opening_browser",
    );
    const loginId = browsers.beginLogin("a").loginId;
    assert.equal(loginId, browsers.beginLogin("a").loginId);
    await until(() => browsers.logins.status("a")?.state === "waiting_for_login");
    assert.deepEqual(launches, [true, false]);
    assert.equal(contexts[0]?.pages().length, 0);
    await assert.rejects(site.getProfile("a"), code("LOGIN_IN_PROGRESS"));
    assert.throws(() => browsers.beginLogin("unknown"), code("UNKNOWN_ACCOUNT"));
    const context = contexts[1];
    assert.ok(context);
    await signIn(context, "a");
    await until(() => browsers.logins.status("a")?.state === "authenticated");
    const status = await browsers.status("a");
    assert.equal(status.savedSession, true);
    assert.equal(status.browserOpen, false);
    assert.equal(context.pages().length, 0);
    if (process.platform !== "win32")
      assert.equal((await stat(join(f.directory, "accounts/a/session.json"))).mode & 0o777, 0o600);
    assert.equal((await site.getProfile("a")).fields.first_name?.value, "Fixture a");
    assert.equal(launches[2], true);
    assert.equal((await browsers.status("b")).savedSession, false);
    const metadata = await client.callTool({
      name: "get_account_status",
      arguments: { accountId: "a" },
    });
    assert.ok(JSON.stringify(metadata).includes('"state":"authenticated"'));
    assert.ok(!JSON.stringify(metadata).includes("fixture_account"));
    assert.deepEqual([f.state().saves, f.state().uploads, f.state().sends], [0, 0, 0]);
    await browsers.close();
    const restarted = new WgGesucht(config);
    try {
      assert.equal((await restarted.getProfile("a")).fields.first_name?.value, "Fixture a");
      await assert.rejects(restarted.getProfile("b"), code("LOGIN_REQUIRED"));
    } finally {
      await restarted.browsers.close();
    }
  } finally {
    await client.close();
    await server.close();
    await browsers.close();
    await f.close();
  }
});

test("manual close, timeout and server shutdown release login windows and profile locks", async () => {
  const f = await fixture();
  const config = { ...f.config, env: {} };
  const { browsers, contexts } = testBrowser(config);
  try {
    browsers.beginLogin("a");
    await until(() => browsers.logins.status("a")?.state === "waiting_for_login");
    await contexts[0]?.close();
    await until(() => browsers.logins.status("a")?.state === "cancelled");
    browsers.beginLogin("a", 1500);
    await until(() => browsers.logins.status("a")?.state === "timed_out");
    await until(async () => !(await browsers.status("a")).browserOpen);
    browsers.beginLogin("a");
    await until(() => browsers.logins.status("a")?.state === "waiting_for_login");
    await browsers.close();
    assert.equal((await browsers.status("a")).browserOpen, false);
    assert.equal(browsers.logins.status("a")?.state, "cancelled");
    const other = new BrowserManager(config);
    try {
      await other.run("a", async () => true, false);
    } finally {
      await other.close();
    }
  } finally {
    await browsers.close();
    await f.close();
  }
});

test("local login wizards isolate accounts and remain independent", async () => {
  const f = await fixture();
  const config = { ...f.config, env: {}, readOnly: true };
  const byAccount = new Map<string, BrowserContext>();
  const browsers = new BrowserManager(config, async (directory, options) => {
    const accountId = basename(dirname(directory));
    if (!byAccount.has(accountId)) assert.equal(options?.headless, false);
    const context = await chromium.launchPersistentContext(directory, {
      ...options,
      headless: true,
    });
    if (options?.headless === false) byAccount.set(accountId, context);
    return context;
  });
  try {
    browsers.beginLogin("a");
    browsers.beginLogin("b");
    await until(
      () =>
        browsers.logins.status("a")?.state === "waiting_for_login" &&
        browsers.logins.status("b")?.state === "waiting_for_login",
    );
    const b = byAccount.get("b");
    assert.ok(b);
    await signIn(b, "b");
    await until(() => browsers.logins.status("b")?.state === "authenticated");
    assert.equal(browsers.logins.status("a")?.state, "waiting_for_login");
    assert.equal((await browsers.status("a")).savedSession, false);
    const site = new WgGesucht(config, browsers);
    assert.equal((await site.getProfile("b")).fields.first_name?.value, "Fixture b");
    const a = byAccount.get("a");
    assert.ok(a);
    await a.close();
    await until(() => browsers.logins.status("a")?.state === "cancelled");
    assert.equal((await browsers.status("b")).savedSession, true);
  } finally {
    await browsers.close();
    await f.close();
  }
});
