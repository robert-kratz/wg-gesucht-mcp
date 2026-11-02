import { rm } from "node:fs/promises";

// Remove obsolete compiled entry points when source modules are deleted.
await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
