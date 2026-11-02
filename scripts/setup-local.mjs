import { spawnSync } from "node:child_process";
import { chmod, constants, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "config-only": { type: "boolean" } } });
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (Number(process.versions.node.split(".")[0]) < 24)
  throw new Error("Install Node.js 24 or newer before running setup.");

for (const [source, target] of [
  ["accounts.example.json", "accounts.json"],
  [".env.example", ".env"],
]) {
  try {
    await copyFile(join(root, source), join(root, target), constants.COPYFILE_EXCL);
    await chmod(join(root, target), 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
await mkdir(join(root, "attachments"), { recursive: true, mode: 0o700 });

if (!values["config-only"]) {
  for (const args of [["install", "--frozen-lockfile"], ["browsers:install"], ["build"]]) {
    const windows = process.platform === "win32";
    const result = spawnSync(
      windows ? process.env.ComSpec || "cmd.exe" : "pnpm",
      windows ? ["/d", "/s", "/c", `pnpm ${args.join(" ")}`] : args,
      { cwd: root, stdio: "inherit" },
    );
    if (result.error || result.status !== 0)
      throw new Error(`pnpm ${args.join(" ")} failed. Install pnpm 10.32.1 and rerun setup.`);
  }
}
process.stdout.write(
  "Local setup ready. Existing configuration and saved sessions were preserved.\n",
);
process.stdout.write(
  "Register the local Node.js command in Codex or Claude Code (SETUP.md), then call login_account to sign in.\n",
);
