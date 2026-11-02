import assert from "node:assert/strict";
import { readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { BrowserManager } from "../src/browser.js";
import { loadConfig } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { FileStore } from "../src/files.js";
import { SendJournal } from "../src/journal.js";
import { WgGesucht } from "../src/site.js";
import { fixture } from "./fixture.js";

const code = (expected: string) => (error: unknown) =>
  error instanceof AppError && error.code === expected;

test("configuration, local files and durable send outcomes", async (t) => {
  const f = await fixture();
  try {
    await t.test("paths are relative to the env file and inherited settings win", async () => {
      await writeFile(
        join(f.directory, "accounts.json"),
        JSON.stringify({ accounts: [{ id: "a" }] }),
      );
      await writeFile(
        join(f.directory, ".env"),
        "WG_MCP_CONFIG=accounts.json\nWG_MCP_DATA_DIR=data\nWG_MCP_READ_ONLY=false\n",
      );
      const config = await loadConfig(
        { envFile: join(f.directory, ".env") },
        { WG_MCP_READ_ONLY: "true" },
      );
      assert.equal(config.dataDir, join(f.directory, "data"));
      assert.equal(config.readOnly, true);
      await writeFile(
        join(f.directory, "bad.json"),
        JSON.stringify({ accounts: [{ id: "../escape" }] }),
      );
      await assert.rejects(
        loadConfig({ config: join(f.directory, "bad.json") }, {}),
        code("INVALID_CONFIG"),
      );
    });
    await t.test("file handles are account-bound and symlink escapes are rejected", async () => {
      const files = new FileStore(f.config);
      const file = await files.stage("a", {
        type: "base64",
        filename: "example.txt",
        data: Buffer.from("synthetic").toString("base64"),
      });
      assert.equal((await files.get("a", file.fileId)).bytes, 9);
      await assert.rejects(files.get("b", file.fileId), code("FILE_NOT_FOUND"));
      await assert.rejects(
        files.stage("a", { type: "base64", filename: "../escape.txt", data: "YQ==" }),
        code("INVALID_FILE"),
      );
      await assert.rejects(
        files.stage("a", { type: "base64", filename: "bad.txt", data: "not base64" }),
        code("INVALID_FILE"),
      );
      await symlink(process.execPath, join(f.directory, "escape.txt"));
      await assert.rejects(
        files.stage("a", { type: "path", path: join(f.directory, "escape.txt") }),
        code("FILE_ACCESS_DENIED"),
      );
      const mode = (await stat((await files.get("a", file.fileId)).path)).mode & 0o777;
      if (process.platform !== "win32") assert.equal(mode, 0o600);
    });
    await t.test("confirmed sends survive restarts; unknown sends are not repeated", async () => {
      let calls = 0;
      const journal = new SendJournal(f.directory);
      const result = await journal.send("a", "confirmed-request", { text: "example" }, async () => {
        calls++;
        return { messageId: "1" };
      });
      assert.deepEqual(
        await new SendJournal(f.directory).send(
          "a",
          "confirmed-request",
          { text: "example" },
          async () => {
            calls++;
            return {};
          },
        ),
        result,
      );
      assert.equal(calls, 1);
      await assert.rejects(
        journal.send("a", "confirmed-request", { text: "changed" }, async () => ({})),
        code("REQUEST_ID_CONFLICT"),
      );
      await assert.rejects(
        journal.send("a", "unknown-request", {}, async () => {
          calls++;
          throw Error("simulated connection loss");
        }),
        code("SEND_OUTCOME_UNKNOWN"),
      );
      await assert.rejects(
        new SendJournal(f.directory).send("a", "unknown-request", {}, async () => {
          calls++;
          return {};
        }),
        code("SEND_OUTCOME_UNKNOWN"),
      );
      assert.equal(calls, 2);
    });
  } finally {
    await f.close();
  }
});

test("Playwright adapters operate only against a synthetic local website", async (t) => {
  const f = await fixture();
  const site = new WgGesucht(f.config);
  try {
    await t.test("ENV login persists sessions and isolates accounts", async () => {
      assert.equal((await site.getProfile("a")).fields.first_name?.value, "Fixture a");
      assert.equal((await site.getProfile("b")).fields.first_name?.value, "Fixture b");
      assert.equal((await site.browsers.status("a")).savedSession, true);
      const session = JSON.parse(
        await readFile(join(f.directory, "accounts/a/session.json"), "utf8"),
      ) as { cookies: { value: string }[] };
      assert.ok(session.cookies.some((c) => c.value === "a"));
      assert.ok(!session.cookies.some((c) => c.value === "b"));
    });
    await t.test("a second process cannot open the same browser profile", async () => {
      const other = new BrowserManager(f.config);
      try {
        await assert.rejects(
          other.run("a", async () => true),
          code("ACCOUNT_BUSY"),
        );
      } finally {
        await other.close();
      }
    });
    await t.test("listing ownership and pagination", async () => {
      assert.equal((await site.listListings("a", 1)).items[0]?.listingId, "101");
      assert.equal((await site.listListings("a", 2)).items[0]?.listingId, "102");
      await assert.rejects(
        site.updateListing("a", "999", { ad_title: "must not save" }),
        code("LISTING_NOT_OWNED"),
      );
      assert.equal(f.state().saves, 0);
    });
    await t.test("partial listing/profile saves preserve omitted values", async () => {
      await site.updateListing("a", "101", { ad_title: "Updated fixture", rent_costs: 550 });
      assert.equal(f.state().listings["101"]?.description, "Synthetic room");
      assert.equal(f.state().listings["101"]?.rent, "550");
      await site.updateProfile("a", { first_name: "Changed fixture", title: "2" });
      assert.equal(f.state().profile.last_name, "Example");
      await assert.rejects(
        site.updateProfile("a", { title: "not-an-option" }),
        code("INVALID_FIELD"),
      );
      assert.equal((await site.getProfile("b")).fields.first_name?.value, "Fixture b");
    });
    await t.test("advertisement activation is verified and idempotent", async () => {
      assert.equal((await site.setListingStatus("a", "101", false)).active, false);
      assert.equal((await site.setListingStatus("a", "101", false)).changed, false);
    });
    await t.test(
      "read-only mode blocks saves and uploads before the browser is touched",
      async () => {
        const readOnly = new WgGesucht({ ...f.config, readOnly: true });
        try {
          await assert.rejects(
            readOnly.updateProfile("a", { first_name: "Blocked" }),
            code("READ_ONLY"),
          );
          await assert.rejects(
            readOnly.sendMessage("a", "201", "Blocked", [], "read-only-request"),
            code("READ_ONLY"),
          );
          await assert.rejects(
            readOnly.managePhotos("a", "101", { type: "add", fileId: "bad" }),
            code("READ_ONLY"),
          );
          await assert.rejects(readOnly.updateProfilePhoto("a", "bad"), code("READ_ONLY"));
          assert.equal((await readOnly.browsers.status("a")).browserOpen, false);
        } finally {
          await readOnly.browsers.close();
        }
      },
    );
    await t.test("inbox and history pagination, plus attachment download", async () => {
      assert.equal((await site.listConversations("a")).items[0]?.unread, true);
      assert.equal((await site.listConversations("a", 2)).items[0]?.conversationId, "202");
      assert.equal(
        (await site.getConversation("a", "201")).messages[0]?.text,
        "Synthetic incoming message",
      );
      const attachment = await site.downloadAttachment("a", "201", "301");
      assert.equal(attachment.filename, "fixture.txt");
      assert.equal(
        await readFile((await site.files.get("a", attachment.fileId)).path, "utf8"),
        "Synthetic attachment",
      );
      await assert.rejects(
        site.downloadAttachment("a", "201", "999"),
        code("ATTACHMENT_NOT_FOUND"),
      );
    });
    await t.test("staging stays local; attachments upload during a deduplicated send", async () => {
      const file = await site.files.stage("a", {
        type: "base64",
        filename: "example.txt",
        data: Buffer.from("synthetic").toString("base64"),
      });
      assert.equal(f.state().uploads, 0);
      const sent = await site.sendMessage(
        "a",
        "201",
        "Synthetic outgoing",
        [file.fileId],
        "fixture-send-request",
      );
      assert.equal(sent.confirmed, true);
      assert.equal(f.state().uploads, 1);
      assert.equal(f.state().sends, 1);
      assert.deepEqual(
        await site.sendMessage(
          "a",
          "201",
          "Synthetic outgoing",
          [file.fileId],
          "fixture-send-request",
        ),
        sent,
      );
      assert.equal(f.state().sends, 1);
      assert.equal((await site.getConversation("a", "201", undefined, 1)).nextBeforeMessageId, "2");
      assert.equal((await site.getConversation("a", "201", "2")).messages[0]?.messageId, "1");
      await site.startConversation(
        "a",
        `${f.config.baseUrl}/wg-zimmer.999.html`,
        "Synthetic new contact",
        [],
        "fixture-start-request",
      );
      assert.equal(f.state().sends, 2);
    });
    await t.test("photo upload and deletion use the fixture only", async () => {
      const image = await site.files.stage("a", {
        type: "base64",
        filename: "fixture.png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOccAAAAASUVORK5CYII=",
      });
      await site.managePhotos("a", "101", { type: "add", fileId: image.fileId });
      const photos = (await site.getListing("a", "101")).photos;
      assert.equal(photos.length, 2);
      await site.managePhotos("a", "101", {
        type: "caption",
        photoId: "1",
        caption: "Updated fixture caption",
      });
      assert.equal(f.state().listings["101"]?.photos[0]?.caption, "Updated fixture caption");
      const reversed = photos.map((photo) => photo.photoId).reverse();
      await site.managePhotos("a", "101", { type: "reorder", photoIds: reversed });
      assert.deepEqual(
        f.state().listings["101"]?.photos.map((photo) => photo.id),
        reversed,
      );
      await site.managePhotos("a", "101", { type: "remove", photoId: "1" });
      assert.equal((await site.getListing("a", "101")).photos.length, 1);
      assert.equal((await site.updateProfilePhoto("a", image.fileId)).uploaded, true);
    });
    await t.test("portable sessions round-trip without leaking unrelated sites", async () => {
      const output = join(f.directory, "a.session.json");
      await site.browsers.exportSession("a", output);
      const exported = JSON.parse(await readFile(output, "utf8")) as {
        storageState: { cookies: { domain: string }[] };
      };
      assert.ok(exported.storageState.cookies.every((c) => c.domain === "127.0.0.1"));
      await site.browsers.importSession("a", output);
    });
    await t.test("expired authentication yields an actionable error", async () => {
      f.config.env.A_EMAIL = undefined;
      f.config.env.A_PASSWORD = undefined;
      await site.browsers.run(
        "a",
        async (_page, context) => {
          await context.clearCookies();
        },
        false,
      );
      await assert.rejects(site.getProfile("a"), code("LOGIN_REQUIRED"));
    });
  } finally {
    await site.browsers.close();
    await f.close();
  }
});
