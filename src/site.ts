import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { BrowserManager } from "./browser.js";
import type { Config } from "./config.js";
import { AppError, assertWrites } from "./errors.js";
import {
  type FieldValue,
  fillPatch,
  LISTING_FIELDS,
  listingPatchSchema,
  PROFILE_FIELDS,
  patchMatches,
  profilePatchSchema,
  readFields,
} from "./fields.js";
import { FileStore, MAX_FILE_BYTES, type StagedFile } from "./files.js";
import { SendJournal } from "./journal.js";

const numericId = /^\d{1,20}$/;
interface Listing {
  listingId: string;
  kind: "offer" | "request";
  editUrl: string;
  title: string;
  active: boolean | null;
}
interface Attachment {
  attachmentId: string;
  filename: string;
  messageId?: string;
}
export class WgGesucht {
  readonly browsers: BrowserManager;
  readonly files: FileStore;
  private readonly journal: SendJournal;
  constructor(
    readonly config: Config,
    browsers?: BrowserManager,
  ) {
    this.browsers = browsers ?? new BrowserManager(config);
    this.files = new FileStore(config);
    this.journal = new SendJournal(config.dataDir);
  }
  private id(id: string): string {
    if (!numericId.test(id))
      throw new AppError("INVALID_ID", "Expected a numeric WG-Gesucht identifier.");
    return id;
  }
  private async navigate(page: Page, path: string) {
    await page.goto(new URL(path, this.config.baseUrl).href, { waitUntil: "domcontentloaded" });
    if (new URL(page.url()).origin !== new URL(this.config.baseUrl).origin)
      throw new AppError(
        "UNEXPECTED_REDIRECT",
        "WG-Gesucht redirected outside the configured website.",
      );
  }
  private async pagination(page: Page, number: number) {
    if (number === 1) return;
    const link = page
      .locator(".pagination a, .simple-pagination a")
      .filter({ hasText: new RegExp(`^\\s*${number}\\s*$`) })
      .first();
    if (!(await link.count()))
      throw new AppError("PAGE_NOT_FOUND", "That page is not available in the website pagination.");
    const previous = await page
      .locator("[data-conversation_id],a[href*=bearbeiten]")
      .evaluateAll((xs) =>
        xs.map((e) => e.getAttribute("data-conversation_id") || e.getAttribute("href")).join("|"),
      );
    await link.click();
    await page.waitForFunction(
      (before) =>
        Array.from(document.querySelectorAll("[data-conversation_id],a[href*=bearbeiten]"))
          .map((e) => e.getAttribute("data-conversation_id") || e.getAttribute("href"))
          .join("|") !== before,
      previous,
    );
  }
  private async nextPage(page: Page, current: number): Promise<number | null> {
    const next = page
      .locator(".pagination a,.simple-pagination a")
      .filter({ hasText: new RegExp(`^\\s*${current + 1}\\s*$`) });
    return (await next.count()) ? current + 1 : null;
  }
  private async listingsOnPage(page: Page): Promise<Listing[]> {
    return page.evaluate(() => {
      const records = new Map<string, Listing>();
      for (const link of document.querySelectorAll<HTMLAnchorElement>(
        'a[href*="angebot-bearbeiten.html"],a[href*="gesuch-bearbeiten.html"]',
      )) {
        const url = new URL(link.href);
        const id = url.searchParams.get("offer_id") || url.searchParams.get("request_id");
        if (!id || records.has(id)) continue;
        const status = document.querySelector(`.update_deactivated_status[data-asset_id="${id}"]`);
        const card = link.closest(".my_asset_item,.wgg_card,.panel,.ad_list_item,.ad-list-view");
        records.set(id, {
          listingId: id,
          kind: url.pathname.includes("gesuch") ? "request" : "offer",
          editUrl: url.href,
          title: card?.querySelector("h2,h3,.headline")?.textContent?.trim() || `Listing ${id}`,
          active:
            status && ["0", "1"].includes(status.getAttribute("data-deactivated") || "")
              ? status.getAttribute("data-deactivated") === "1"
              : null,
        });
      }
      return [...records.values()];
    });
  }
  async listListings(accountId: string, pageNumber = 1) {
    return this.browsers.run(accountId, async (page) => {
      await this.navigate(page, "/meine-anzeigen.html");
      await this.pagination(page, pageNumber);
      const items = (await this.listingsOnPage(page)).map(({ editUrl: _editUrl, ...item }) => item);
      return {
        accountId,
        items,
        page: pageNumber,
        nextPage: await this.nextPage(page, pageNumber),
      };
    });
  }
  private async ownListing(page: Page, listingId: string): Promise<Listing> {
    this.id(listingId);
    await this.navigate(page, "/meine-anzeigen.html");
    for (let number = 1; number <= 100; number++) {
      if (number > 1) await this.pagination(page, number);
      const item = (await this.listingsOnPage(page)).find((item) => item.listingId === listingId);
      if (item) return item;
      if (!(await this.nextPage(page, number))) break;
    }
    throw new AppError(
      "LISTING_NOT_OWNED",
      "This advertisement was not found in the account's own listings. No edit was attempted.",
    );
  }
  private async editListing(page: Page, listingId: string) {
    const listing = await this.ownListing(page, listingId);
    if (new URL(listing.editUrl).origin !== new URL(this.config.baseUrl).origin)
      throw new AppError("UNEXPECTED_LINK", "The edit link is outside WG-Gesucht.");
    await this.navigate(page, listing.editUrl);
    await page.locator('[name="ad_title"]').waitFor({ state: "attached" });
    return listing;
  }
  private async photos(page: Page) {
    return page.locator("#photos .image_uploader_wrapper[data-image_id]").evaluateAll((xs) =>
      xs.map((e) => ({
        photoId: e.getAttribute("data-image_id") || "",
        caption: e.querySelector<HTMLInputElement>('input[name="caption"]')?.value || "",
        url: e.querySelector<HTMLImageElement>("img")?.src || "",
      })),
    );
  }
  async getListing(accountId: string, listingId: string) {
    return this.browsers.run(accountId, async (page) => {
      const { editUrl: _editUrl, ...listing } = await this.editListing(page, listingId);
      return {
        accountId,
        ...listing,
        fields: await readFields(page, LISTING_FIELDS),
        photos: await this.photos(page),
      };
    });
  }
  async updateListing(accountId: string, listingId: string, input: Record<string, FieldValue>) {
    assertWrites(this.config.readOnly);
    const patch = listingPatchSchema.parse(input);
    return this.browsers.run(accountId, async (page) => {
      await this.editListing(page, listingId);
      const url = page.url();
      await fillPatch(page, await readFields(page, LISTING_FIELDS), patch);
      await this.submit(page, page.locator("#update_offer,#update_request").first());
      await this.navigate(page, url);
      const fields = await readFields(page, LISTING_FIELDS);
      if (!patchMatches(fields, patch))
        throw new AppError(
          "SAVE_NOT_CONFIRMED",
          "The saved listing does not match every requested field. Inspect it manually before retrying.",
        );
      return { accountId, listingId, updatedFields: Object.keys(patch), fields };
    });
  }
  async setListingStatus(accountId: string, listingId: string, active: boolean) {
    assertWrites(this.config.readOnly);
    return this.browsers.run(accountId, async (page) => {
      const listing = await this.ownListing(page, listingId);
      if (listing.active === active) return { accountId, listingId, active, changed: false };
      if (listing.active === null)
        throw new AppError(
          "UNSUPPORTED_LAYOUT",
          "The current advertisement status could not be established. No status change was attempted.",
        );
      const toggle = page.locator(
        `.update_deactivated_status[data-asset_id="${this.id(listingId)}"]`,
      );
      const menu = toggle.locator('xpath=ancestor::*[contains(@class,"dropdown")][1]');
      if (!(await toggle.isVisible()) && (await menu.count()))
        await menu.locator('[data-toggle="dropdown"]').first().click();
      await this.submit(page, toggle);
      const saved = await this.ownListing(page, listingId);
      if (saved.active !== active)
        throw new AppError(
          "SAVE_NOT_CONFIRMED",
          "The advertisement status was not confirmed. A date or verification dialog may require manual attention.",
        );
      return { accountId, listingId, active, changed: true };
    });
  }
  private async submit(page: Page, control: Locator) {
    return this.mutate(page, () => control.click());
  }
  private async profilePhoto(page: Page): Promise<string | null> {
    const image = page.locator("#profile_image_element");
    return (await image.count()) ? image.getAttribute("src") : null;
  }
  private async mutate(page: Page, action: () => Promise<unknown>) {
    const response = page.waitForResponse(
      (r) =>
        new URL(r.url()).origin === new URL(this.config.baseUrl).origin &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(r.request().method()),
      { timeout: this.config.timeoutMs },
    );
    // Register rejection handling before a click can fail; never resubmit automatically.
    const pending = response.catch(() => null);
    await action();
    const result = await pending;
    if (!result?.ok())
      throw new AppError(
        "SAVE_NOT_CONFIRMED",
        "The website did not confirm the operation. Inspect its state before retrying.",
      );
    await result.finished();
  }
  async getProfile(accountId: string) {
    return this.browsers.run(accountId, async (page) => {
      await this.navigate(page, "/my-profile.html");
      await page.locator("#profile_form").waitFor({ state: "attached" });
      return {
        accountId,
        fields: await readFields(page, PROFILE_FIELDS),
        photoUrl: await this.profilePhoto(page),
      };
    });
  }
  async updateProfile(accountId: string, input: Record<string, FieldValue>) {
    assertWrites(this.config.readOnly);
    const patch = profilePatchSchema.parse(input);
    return this.browsers.run(accountId, async (page) => {
      await this.navigate(page, "/my-profile.html");
      await fillPatch(page, await readFields(page, PROFILE_FIELDS), patch);
      await this.submit(page, page.locator('#profile_form button[type="submit"]'));
      await this.navigate(page, "/my-profile.html");
      const fields = await readFields(page, PROFILE_FIELDS);
      if (!patchMatches(fields, patch))
        throw new AppError(
          "SAVE_NOT_CONFIRMED",
          "Not all profile fields match the saved values. Inspect the profile before retrying.",
        );
      return { accountId, updatedFields: Object.keys(patch), fields };
    });
  }
  private async payload(accountId: string, fileId: string) {
    const file = await this.files.get(accountId, fileId);
    const mime: Record<string, string> = {
      ".pdf": "application/pdf",
      ".txt": "text/plain",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
    };
    return {
      name: file.filename,
      mimeType: mime[extname(file.filename).toLowerCase()] || "application/octet-stream",
      buffer: await readFile(file.path),
    };
  }
  async updateProfilePhoto(accountId: string, fileId: string) {
    assertWrites(this.config.readOnly);
    const payload = await this.payload(accountId, fileId);
    if (!/^image\/(jpeg|png|gif)$/.test(payload.mimeType))
      throw new AppError("INVALID_FILE", "Profile photos must be JPG, PNG, or GIF.");
    return this.browsers.run(accountId, async (page) => {
      await this.navigate(page, "/my-profile.html");
      const previous = await this.profilePhoto(page);
      await page.locator("#profile-image").setInputFiles(payload);
      await page.locator("#save_edited_image").waitFor({ state: "visible" });
      await this.submit(page, page.locator("#save_edited_image"));
      await page.waitForFunction((before) => {
        const image = document.querySelector<HTMLImageElement>("#profile_image_element");
        return Boolean(image?.getAttribute("src") && image.getAttribute("src") !== before);
      }, previous);
      await this.navigate(page, "/my-profile.html");
      const photoUrl = await page.locator("#profile_image_element").getAttribute("src");
      if (!photoUrl || photoUrl === previous)
        throw new AppError(
          "SAVE_NOT_CONFIRMED",
          "The profile photo could not be verified after reload.",
        );
      return { accountId, uploaded: true, photoUrl };
    });
  }
  async managePhotos(
    accountId: string,
    listingId: string,
    action:
      | { type: "add"; fileId: string }
      | { type: "remove"; photoId: string }
      | { type: "caption"; photoId: string; caption: string }
      | { type: "reorder"; photoIds: string[] },
  ) {
    assertWrites(this.config.readOnly);
    const payload =
      action.type === "add" ? await this.payload(accountId, action.fileId) : undefined;
    if (payload && !/^image\/(jpeg|png|gif)$/.test(payload.mimeType))
      throw new AppError("INVALID_FILE", "Advertisement photos must be JPG, PNG, or GIF.");
    return this.browsers.run(accountId, async (page) => {
      await this.editListing(page, listingId);
      await page.locator('.form_nav_item[data-form_block="photos"]').click();
      const before = await this.photos(page);
      if (action.type === "add" && payload) {
        await page.locator("#photo_input").setInputFiles(payload);
        await page.waitForFunction(
          (n) =>
            document.querySelectorAll("#photos .image_uploader_wrapper[data-image_id]").length > n,
          before.length,
        );
      } else if (action.type === "remove" || action.type === "caption") {
        this.id(action.photoId);
        const wrapper = page.locator(
          `#photos .image_uploader_wrapper[data-image_id="${action.photoId}"]`,
        );
        if (!(await wrapper.count()))
          throw new AppError("PHOTO_NOT_FOUND", "The photo does not belong to this advertisement.");
        if (action.type === "remove") {
          await this.submit(page, wrapper.locator(".image_uploader_delete"));
          await wrapper.waitFor({ state: "detached" });
        } else {
          await this.mutate(page, async () => {
            await wrapper.locator('input[name="caption"]').fill(action.caption);
            await wrapper.locator('input[name="caption"]').blur();
          });
        }
      } else if (action.type === "reorder") {
        if (
          new Set(action.photoIds).size !== before.length ||
          action.photoIds.length !== before.length ||
          action.photoIds.some((id) => !before.some((p) => p.photoId === id))
        )
          throw new AppError("INVALID_PHOTO_ORDER", "Provide every existing photoId exactly once.");
        for (let i = 0; i < action.photoIds.length; i++) {
          const current = await this.photos(page);
          const desired = action.photoIds[i];
          const target = current[i];
          if (desired && target && desired !== target.photoId) {
            const wrapper = page.locator(`#photos [data-image_id="${this.id(desired)}"]`);
            const source = (await wrapper.locator(".image_panel_height").count())
              ? wrapper.locator(".image_panel_height").first()
              : wrapper.locator(".sortable-handle").first();
            const targetWrapper = page.locator(`#photos [data-image_id="${target.photoId}"]`);
            const targetHandle = (await targetWrapper.locator(".image_panel_height").count())
              ? targetWrapper.locator(".image_panel_height").first()
              : targetWrapper.locator(".sortable-handle").first();
            await source.dragTo(targetHandle);
          }
        }
        // The site persists sortable positions after the advertisement save,
        // not when the pointer is released. Observe that second UI request.
        const positions = page
          .waitForResponse(
            (response) =>
              response.request().method() === "PATCH" &&
              new URL(response.url()).origin === new URL(this.config.baseUrl).origin &&
              new URL(response.url()).pathname.startsWith("/api/images/") &&
              new URL(response.url()).pathname.includes(`/${listingId}/users/`),
            { timeout: this.config.timeoutMs },
          )
          .catch(() => null);
        await this.submit(page, page.locator("#update_offer,#update_request").first());
        const savedPositions = await positions;
        if (!savedPositions?.ok())
          throw new AppError(
            "SAVE_NOT_CONFIRMED",
            "The website did not confirm the saved photo order.",
          );
        await savedPositions.finished();
      }
      const url = page.url();
      const after = await this.photos(page);
      await this.navigate(page, url);
      const saved = await this.photos(page);
      if (
        action.type === "add"
          ? saved.length <= before.length
          : action.type === "remove"
            ? saved.some((p) => p.photoId === action.photoId)
            : action.type === "caption"
              ? saved.find((p) => p.photoId === action.photoId)?.caption !== action.caption
              : saved.map((p) => p.photoId).join() !== action.photoIds.join()
      )
        throw new AppError(
          "SAVE_NOT_CONFIRMED",
          "The photo operation could not be verified after reload. Inspect the advertisement before retrying.",
          { observedPhotoCount: after.length },
        );
      return { accountId, listingId, photos: saved };
    });
  }
  async listConversations(accountId: string, pageNumber = 1) {
    return this.browsers.run(accountId, async (page) => {
      await this.navigate(page, "/nachrichten.html");
      await this.pagination(page, pageNumber);
      const items = await page.locator("[data-conversation_id].panel-body").evaluateAll((xs) =>
        xs.map((e) => ({
          conversationId: e.getAttribute("data-conversation_id"),
          unread: e.classList.contains("conversation_unread"),
          preview: e.querySelector(".latest_message")?.textContent?.trim() || "",
          participant:
            e
              .querySelector(
                ".contacted_user_public_name,.list_item_public_name,.user_name,.name,.conversation_user_name",
              )
              ?.textContent?.trim() || "",
          listingTitle: e.querySelector(".conversations_list_ad_title")?.textContent?.trim() || "",
          lastMessageAt:
            e.querySelector(".latest_message_timestamp_list")?.textContent?.trim() || null,
          lastMessageId: e.getAttribute("data-message_id"),
        })),
      );
      return {
        accountId,
        items,
        page: pageNumber,
        nextPage: await this.nextPage(page, pageNumber),
      };
    });
  }
  private async conversation(page: Page, conversationId: string) {
    await this.navigate(page, `/nachricht.html?nachrichten-id=${this.id(conversationId)}`);
    await page.locator("#message_input_container").waitFor({ state: "attached" });
    const actual = await page
      .locator("#conversation_id")
      .inputValue()
      .catch(() => conversationId);
    if (actual !== conversationId)
      throw new AppError(
        "CONVERSATION_NOT_FOUND",
        "The conversation could not be opened for this account.",
      );
  }
  private async attachments(page: Page): Promise<Attachment[]> {
    return page.locator(".download_attachment_conversation[data-file_id]").evaluateAll((xs) =>
      Array.from(
        new Map(
          xs.map((e) => {
            const id = e.getAttribute("data-file_id") || "";
            return [
              id,
              {
                attachmentId: id,
                filename:
                  e.getAttribute("download") ||
                  e.getAttribute("title") ||
                  e.textContent?.trim() ||
                  `attachment-${id}`,
                messageId: e.getAttribute("data-message_id") || undefined,
              },
            ];
          }),
        ).values(),
      ),
    );
  }
  async getConversation(
    accountId: string,
    conversationId: string,
    beforeMessageId?: string,
    limit = 50,
  ) {
    return this.browsers.run(accountId, async (page) => {
      await this.conversation(page, conversationId);
      let messages = await this.messages(page);
      if (beforeMessageId)
        messages = messages.filter((m) => BigInt(m.messageId) < BigInt(this.id(beforeMessageId)));
      const items = messages.slice(-limit);
      return {
        accountId,
        conversationId,
        messages: items,
        attachments: await this.attachments(page),
        oldestLoadedMessageId: messages[0]?.messageId,
        nextBeforeMessageId: messages.length > limit ? items[0]?.messageId : null,
        note: "Opening a conversation follows WG-Gesucht's normal read-status behavior. Only messages currently loaded by the website are returned.",
      };
    });
  }
  private async messages(page: Page) {
    return page
      .locator(
        '#messages_container .message[id^="last_message_id_"],.message[id^="last_message_id_"]',
      )
      .evaluateAll((xs) =>
        xs.map((e) => ({
          messageId: e.id.replace("last_message_id_", ""),
          text:
            e.querySelector(".message_text,.message_content,.message_body")?.textContent?.trim() ||
            e.textContent?.trim() ||
            "",
          outgoing:
            e.classList.contains("my_message") ||
            e.classList.contains("own_message") ||
            e.classList.contains("message_sent") ||
            Boolean(e.querySelector(".text_delivery_message")),
          timestamp:
            e.querySelector("time")?.getAttribute("datetime") ||
            e.querySelector(".message_timestamp,.timestamp")?.textContent?.trim() ||
            null,
        })),
      );
  }
  async sendMessage(
    accountId: string,
    conversationId: string,
    text: string,
    fileIds: string[],
    requestId: string,
  ) {
    assertWrites(this.config.readOnly);
    const payloads = await Promise.all(fileIds.map((id) => this.payload(accountId, id)));
    return this.browsers.run(accountId, async (page) => {
      await this.conversation(page, conversationId);
      return this.journal.send(accountId, requestId, { conversationId, text, fileIds }, () =>
        this.sendOnPage(page, accountId, text, payloads),
      );
    });
  }
  async startConversation(
    accountId: string,
    listingUrl: string,
    text: string,
    fileIds: string[],
    requestId: string,
  ) {
    assertWrites(this.config.readOnly);
    const url = new URL(listingUrl);
    if (
      url.origin !== new URL(this.config.baseUrl).origin ||
      !/\.\d+\.html$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new AppError(
        "INVALID_LISTING_URL",
        "Use a canonical HTTPS WG-Gesucht advertisement URL without query parameters or a fragment.",
      );
    const payloads = await Promise.all(fileIds.map((id) => this.payload(accountId, id)));
    return this.browsers.run(accountId, async (page) => {
      await this.navigate(page, url.href);
      const contact = page.locator('a[href*="nachricht-senden"],a[href*="nachricht.html"]').first();
      if (await contact.count()) {
        const href = await contact.getAttribute("href");
        if (!href || href === "#") await contact.click();
        else {
          const destination = new URL(href, page.url());
          if (
            destination.origin !== url.origin ||
            !/^\/(?:nachricht-senden|nachricht)\.html$/.test(destination.pathname)
          )
            throw new AppError(
              "UNEXPECTED_LINK",
              "The contact link is not a WG-Gesucht message form.",
            );
          await this.navigate(page, destination.href);
        }
      } else
        await page
          .getByRole("link", { name: /Nachricht (senden|schreiben)/i })
          .first()
          .click();
      await page
        .locator("#message_input,#message_content,textarea[name=content]")
        .first()
        .waitFor({ state: "visible" });
      const targetId = /\.(\d+)\.html$/.exec(url.pathname)?.[1];
      const formAdId = await page
        .locator('[name="ad_id"],#conversation_ad_id')
        .first()
        .inputValue()
        .catch(() => null);
      if (!targetId || formAdId !== targetId)
        throw new AppError(
          "AD_TARGET_MISMATCH",
          "The message form could not be verified against the requested advertisement. No message was sent.",
        );
      return this.journal.send(accountId, requestId, { listingUrl, text, fileIds }, () =>
        this.sendOnPage(page, accountId, text, payloads),
      );
    });
  }
  private async sendOnPage(
    page: Page,
    accountId: string,
    text: string,
    payloads: Awaited<ReturnType<WgGesucht["payload"]>>[],
  ) {
    const existing = new Set((await this.messages(page)).map((m) => m.messageId));
    const messageCount = await page.locator("#messages_container .message").count();
    // A browser profile can retain a human's draft. Never send an unseen draft or pre-attached documents.
    const composer = page.locator("#message_input,#message_content,textarea[name=content]").first();
    if (
      (await composer.inputValue()).trim() ||
      (await page
        .locator(".pre_attached_file,.pre_attached_application_package,.pre_attached_ad")
        .count())
    )
      throw new AppError(
        "EXISTING_DRAFT",
        "A draft or pre-attached item exists. Resolve it manually before sending through MCP.",
      );
    if (
      (await page.locator("#wgg_plus_toggle").count()) &&
      (await page.locator("#wgg_plus_toggle").isChecked())
    )
      throw new AppError(
        "PAID_OPTION_ACTIVE",
        "A paid messaging option is selected. Resolve it manually; the server will not open a checkout.",
      );
    for (const payload of payloads) {
      if (!(await page.locator("#file_input").count()))
        throw new AppError(
          "ATTACHMENTS_UNAVAILABLE",
          "This message form does not offer attachments.",
        );
      const attach = page.locator(".attach_file").first();
      if ((await attach.count()) && !(await attach.isVisible())) {
        const button = page.getByRole("button", { name: "Anhang", exact: true }).first();
        if (await button.count()) await button.click();
      }
      if (await attach.isVisible()) await attach.click();
      const count = await page.locator(".pre_attached_file").count();
      await page.locator("#file_input").setInputFiles(payload);
      await page.waitForFunction(
        (n) => document.querySelectorAll(".pre_attached_file").length > n,
        count,
      );
      const confirm = page
        .locator("#attachments_modal")
        .getByRole("button", { name: "Bestätigen", exact: true });
      if (await confirm.isVisible()) await confirm.click();
    }
    await composer.fill(text);
    if (await page.locator(".create_new_conversation").count()) {
      await page.locator(".create_new_conversation").first().click();
      await page.locator("#message_successfully_sent").waitFor({ state: "visible" });
      const href = await page
        .locator('#message_successfully_sent a[href*="nachricht.html"]')
        .first()
        .getAttribute("href")
        .catch(() => null);
      return {
        accountId,
        conversationId: href ? new URL(href, page.url()).searchParams.get("nachrichten-id") : null,
        messageIds: [] as string[],
        confirmed: true,
      };
    }
    await page
      .locator(".send_messages,button[type=submit]")
      .filter({ hasText: /Senden|Nachricht senden/ })
      .first()
      .click();
    // WG-Gesucht appends a delivery confirmation next to the newly rendered
    // message, not inside it. Text replies receive persistent IDs on reload.
    await page.waitForFunction((beforeCount) => {
      const composer = document.querySelector<HTMLTextAreaElement>(
        "#message_input,#message_content,textarea[name=content]",
      );
      const confirmed = Array.from(
        document.querySelectorAll<HTMLElement>(".text_delivery_message"),
      ).some((e) => e.offsetParent !== null);
      return (
        document.querySelectorAll("#messages_container .message").length > beforeCount &&
        composer?.value === "" &&
        confirmed
      );
    }, messageCount);
    const conversationId = await page
      .locator("#conversation_id")
      .inputValue()
      .catch(() => new URL(page.url()).searchParams.get("nachrichten-id"));
    await page.reload({ waitUntil: "domcontentloaded" });
    const sent = (await this.messages(page)).filter(
      (m) => !existing.has(m.messageId) && m.outgoing,
    );
    if (!sent.length || !conversationId)
      throw new AppError(
        "SEND_NOT_CONFIRMED",
        "Delivery appeared successful but could not be verified after reload. Inspect the conversation manually.",
      );
    return { accountId, conversationId, messageIds: sent.map((m) => m.messageId), confirmed: true };
  }
  async downloadAttachment(
    accountId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<StagedFile> {
    this.id(attachmentId);
    return this.browsers.run(accountId, async (page, context) => {
      await this.conversation(page, conversationId);
      const link = page
        .locator(`.download_attachment_conversation[data-file_id="${attachmentId}"]`)
        .first();
      if (!(await link.count()))
        throw new AppError(
          "ATTACHMENT_NOT_FOUND",
          "This attachment is not present in the conversation.",
        );
      const href = await link.getAttribute("href");
      if (href && href !== "#")
        return this.fetchAttachment(context, accountId, new URL(href, page.url()));
      return this.fetchAttachment(
        context,
        accountId,
        new URL(`/user-files.html?file_id=${attachmentId}`, this.config.baseUrl),
      );
    });
  }
  private async fetchAttachment(
    context: BrowserContext,
    accountId: string,
    url: URL,
  ): Promise<StagedFile> {
    if (url.origin !== new URL(this.config.baseUrl).origin)
      throw new AppError(
        "UNSUPPORTED_DOWNLOAD",
        "The attachment download must originate on WG-Gesucht.",
      );
    const response = await context.request.get(url.href, {
      maxRedirects: 0,
      timeout: this.config.timeoutMs,
    });
    if (!response.ok())
      throw new AppError(
        "DOWNLOAD_FAILED",
        "The attachment could not be downloaded without an external redirect.",
      );
    if (Number(response.headers()["content-length"] || 0) > MAX_FILE_BYTES)
      throw new AppError("INVALID_FILE", "The attachment exceeds 10 MiB.");
    const disposition = response.headers()["content-disposition"] || "";
    const filename =
      /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ||
      /filename="?([^";]+)/i.exec(disposition)?.[1];
    if (!filename)
      throw new AppError(
        "UNSUPPORTED_DOWNLOAD",
        "The server did not return an attachment filename.",
      );
    return this.files.store(accountId, decodeURIComponent(filename), await response.body());
  }
}
