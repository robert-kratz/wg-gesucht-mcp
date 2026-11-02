import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("local setup preserves existing private config and sessions on repeated runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wg-mcp-setup-"));
  try {
    await mkdir(join(directory, "scripts"));
    for (const file of ["scripts/setup-local.mjs", ".env.example", "accounts.example.json"])
      await copyFile(resolve(file), join(directory, file));
    const run = () =>
      execFileSync(
        process.execPath,
        [join(directory, "scripts/setup-local.mjs"), "--config-only"],
        { cwd: tmpdir(), encoding: "utf8" },
      );
    run();
    assert.deepEqual(
      await readFile(join(directory, "accounts.json")),
      await readFile(resolve("accounts.example.json")),
    );
    if (process.platform !== "win32")
      assert.equal((await stat(join(directory, ".env"))).mode & 0o777, 0o600);
    const original = "WG_MCP_READ_ONLY=true\n# private local settings\n";
    await writeFile(join(directory, ".env"), original);
    await writeFile(join(directory, "accounts.json"), '{"accounts":[{"id":"synthetic"}]}');
    await mkdir(join(directory, ".data/accounts/synthetic"), { recursive: true });
    await writeFile(join(directory, ".data/accounts/synthetic/session.json"), '{"synthetic":true}');
    assert.ok(run().includes("login_account"));
    assert.equal(await readFile(join(directory, ".env"), "utf8"), original);
    assert.equal(
      await readFile(join(directory, "accounts.json"), "utf8"),
      '{"accounts":[{"id":"synthetic"}]}',
    );
    assert.equal(
      await readFile(join(directory, ".data/accounts/synthetic/session.json"), "utf8"),
      '{"synthetic":true}',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
