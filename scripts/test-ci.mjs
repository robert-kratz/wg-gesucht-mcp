import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = await mkdtemp(join(tmpdir(), "wg-mcp-ci-"));
try {
  const empty = join(temporary, "empty");
  await writeFile(empty, "", { mode: 0o600 });
  const result = spawnSync(
    "act",
    [
      "push",
      "--workflows",
      ".github/workflows/ci.yml",
      "--platform",
      "ubuntu-latest=catthehacker/ubuntu:act-latest",
      "--container-architecture",
      process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
      "--pull=false",
      "--rm",
      "--use-gitignore=true",
      "--bind=false",
      // Never forward production .env, secrets or local client settings to CI.
      "--env-file",
      empty,
      "--secret-file",
      empty,
      "--var-file",
      empty,
      "--input-file",
      empty,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error)
    throw new Error("Install act and start Docker Desktop before running local CI.");
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
