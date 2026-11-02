import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";

const escapeHtml = (v: string) =>
  v.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
interface State {
  profile: Record<string, string>;
  listings: Record<
    string,
    {
      title: string;
      rent: string;
      active: boolean;
      description: string;
      photos: { id: string; caption: string }[];
    }
  >;
  messages: { id: string; text: string; outgoing: boolean }[];
  uploads: number;
  sends: number;
  saves: number;
  profilePhoto: number;
}
export async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wg-mcp-test-"));
  const states = new Map<string, State>();
  const getState = (id: string) => {
    let state = states.get(id);
    if (!state) {
      state = {
        profile: {
          first_name: `Fixture ${id}`,
          last_name: "Example",
          title: "1",
          telephone_main: "",
        },
        listings: {
          "101": {
            title: `Room ${id}`,
            rent: "500",
            active: true,
            description: "Synthetic room",
            photos: [{ id: "1", caption: "Example image" }],
          },
          "102": {
            title: `Other ${id}`,
            rent: "600",
            active: false,
            description: "Synthetic second room",
            photos: [],
          },
        },
        messages: [{ id: "1", text: "Synthetic incoming message", outgoing: false }],
        uploads: 0,
        sends: 0,
        saves: 0,
        profilePhoto: 0,
      };
      states.set(id, state);
    }
    return state;
  };
  const nav =
    '<nav><a href="/my-profile.html">Mein Profil</a><a href="/meine-anzeigen.html">Meine Anzeigen</a><a href="/nachrichten.html">Nachrichten</a></nav>';
  const page = (body: string, script = "") =>
    `<!doctype html><html lang="de"><meta charset="utf-8"><title>WG MCP synthetic fixture</title><body>${nav}${body}<script>${script}</script></body></html>`;
  const body = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString();
  };
  const server = createServer((request, response) => {
    void route(request, response).catch(() => {
      response.writeHead(500).end("Fixture error");
    });
  });
  async function route(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url || "/", "http://localhost");
    const user = /(?:^|; )fixture_account=([ab])(?:;|$)/.exec(request.headers.cookie || "")?.[1];
    const html = (value: string) =>
      response.writeHead(200, { "Content-Type": "text/html" }).end(value);
    const json = (value: unknown) =>
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname === "/login" && request.method === "POST") {
      const data = JSON.parse(await body(request)) as { email: string };
      const account = data.email.startsWith("b") ? "b" : "a";
      response.setHeader(
        "Set-Cookie",
        `fixture_account=${account}; HttpOnly; SameSite=Lax; Path=/`,
      );
      json({ ok: true });
      return;
    }
    if (!user) {
      html(
        `<!doctype html><html><body><a href="#">Mein Konto</a><form id="pre_session_form"><label>E-Mail<input id="pre_session_email"></label><button>Weiter</button></form><form id="login_form" style="display:none"><input id="login_password" type="password"><button>Einloggen</button></form><script>pre_session_form.onsubmit=e=>{e.preventDefault();pre_session_form.style.display='none';login_form.style.display='block'};login_form.onsubmit=async e=>{e.preventDefault();await fetch('/login',{method:'POST',body:JSON.stringify({email:pre_session_email.value})});location.href='/meine-anzeigen.html'};</script></body></html>`,
      );
      return;
    }
    const state = getState(user);
    if (url.pathname === "/save-listing" && request.method === "POST") {
      const data = JSON.parse(await body(request)) as Record<string, string>;
      const listing = state.listings[data.id || ""];
      if (!listing) {
        response.writeHead(404).end();
        return;
      }
      listing.title = data.ad_title || "";
      listing.rent = data.rent_costs || "";
      listing.description = data.freetext_property_description || "";
      state.saves++;
      json({ ok: true });
      return;
    }
    if (url.pathname === "/save-profile" && request.method === "POST") {
      Object.assign(state.profile, JSON.parse(await body(request)));
      state.saves++;
      json({ ok: true });
      return;
    }
    if (url.pathname === "/toggle" && request.method === "POST") {
      const data = JSON.parse(await body(request)) as { id: string };
      const listing = state.listings[data.id];
      if (listing) listing.active = !listing.active;
      state.saves++;
      json({ ok: true });
      return;
    }
    if (url.pathname === "/upload" && request.method === "POST") {
      if ((await body(request)) === "image") state.profilePhoto++;
      state.uploads++;
      json({ id: String(state.uploads) });
      return;
    }
    if (url.pathname === "/send" && request.method === "POST") {
      const data = JSON.parse(await body(request)) as { text: string };
      state.sends++;
      const message = { id: String(state.messages.length + 1), text: data.text, outgoing: true };
      state.messages.push(message);
      json(message);
      return;
    }
    if (url.pathname === "/photos" && request.method === "POST") {
      const data = JSON.parse(await body(request)) as {
        id: string;
        action: string;
        photoId?: string;
        caption?: string;
        photoIds?: string[];
      };
      const listing = state.listings[data.id || "101"];
      if (!listing) {
        response.writeHead(404).end();
        return;
      }
      if (data.action === "add") listing.photos.push({ id: String(Date.now()), caption: "" });
      if (data.action === "remove")
        listing.photos = listing.photos.filter((p) => p.id !== data.photoId);
      if (data.action === "caption") {
        const photo = listing.photos.find((p) => p.id === data.photoId);
        if (photo) photo.caption = data.caption || "";
      }
      if (data.action === "reorder" && data.photoIds)
        listing.photos = data.photoIds
          .map((id) => listing.photos.find((p) => p.id === id))
          .filter((p): p is { id: string; caption: string } => Boolean(p));
      json(listing.photos);
      return;
    }
    if (url.pathname.startsWith("/api/images/offers/") && request.method === "PATCH") {
      const id = url.pathname.split("/")[4] || "";
      const data = JSON.parse(await body(request)) as { photoIds: string[] };
      const listing = state.listings[id];
      if (!listing) {
        response.writeHead(404).end();
        return;
      }
      listing.photos = data.photoIds
        .map((id) => listing.photos.find((p) => p.id === id))
        .filter((p): p is { id: string; caption: string } => Boolean(p));
      json({ ok: true });
      return;
    }
    if (url.pathname === "/user-files.html") {
      response
        .writeHead(200, {
          "Content-Type": "text/plain",
          "Content-Disposition": 'attachment; filename="fixture.txt"',
        })
        .end("Synthetic attachment");
      return;
    }
    if (url.pathname === "/meine-anzeigen.html" || url.pathname === "/") {
      const second = url.searchParams.get("page") === "2";
      const id = second ? "102" : "101";
      const listing = state.listings[id];
      if (!listing) throw Error("Missing fixture");
      html(
        page(
          `<div class="panel"><h3>${escapeHtml(listing.title)}</h3><a href="/angebot-bearbeiten.html?offer_id=${id}">Bearbeiten</a><a class="update_deactivated_status" data-asset_id="${id}" data-deactivated="${listing.active ? "1" : "0"}" href="#">${listing.active ? "Deaktivieren" : "Aktivieren"}</a></div><div class="pagination"><a href="?page=1">1</a><a href="?page=2">2</a></div>`,
          `document.querySelector('.update_deactivated_status').onclick=async e=>{e.preventDefault();await fetch('/toggle',{method:'POST',body:JSON.stringify({id:'${id}'})})}`,
        ),
      );
      return;
    }
    if (url.pathname === "/angebot-bearbeiten.html") {
      const id = url.searchParams.get("offer_id") || "";
      const listing = state.listings[id];
      if (!listing) {
        response.writeHead(403).end();
        return;
      }
      const photos = listing.photos
        .map(
          (p) =>
            `<div class="image_uploader_wrapper" data-image_id="${p.id}" style="display:inline-block;width:120px;height:100px"><div class="sortable-handle" draggable="true" style="width:100px;height:50px">Image</div><a class="image_uploader_delete" href="#">Delete</a><input name="caption" value="${escapeHtml(p.caption)}"></div>`,
        )
        .join("");
      html(
        page(
          `<a class="form_nav_item" data-form_block="start_page" href="#">Start</a><a class="form_nav_item" data-form_block="property_costs" href="#">Kosten</a><a class="form_nav_item" data-form_block="description" href="#">Beschreibung</a><a class="form_nav_item" data-form_block="photos" href="#">Fotos</a><form id="start_page"><label>Title<input name="ad_title" value="${escapeHtml(listing.title)}"></label></form><form id="property_costs"><label>Rent<input type="tel" name="rent_costs" value="${listing.rent}"></label></form><form id="description"><textarea name="freetext_property_description">${escapeHtml(listing.description)}</textarea></form><form id="photos">${photos}<input type="file" id="photo_input" accept="image/jpeg,image/png,image/gif"></form><button id="update_offer">Änderungen speichern</button>`,
          `document.querySelectorAll('.form_nav_item').forEach(e=>e.onclick=x=>x.preventDefault());update_offer.onclick=async()=>{await fetch('/save-listing',{method:'POST',body:JSON.stringify({id:'${id}',...Object.fromEntries([...document.querySelectorAll('form:not(#photos)')].flatMap(f=>[...new FormData(f)]))})});await fetch('/api/images/offers/${id}/users/1',{method:'PATCH',body:JSON.stringify({photoIds:[...photos.querySelectorAll('[data-image_id]')].map(e=>e.dataset.image_id)})});};document.querySelectorAll('.image_uploader_delete').forEach(e=>e.onclick=async event=>{event.preventDefault();const w=e.closest('[data-image_id]');await fetch('/photos',{method:'POST',body:JSON.stringify({id:'${id}',action:'remove',photoId:w.dataset.image_id})});w.remove()});photo_input.onchange=async()=>{await fetch('/photos',{method:'POST',body:JSON.stringify({id:'${id}',action:'add'})});location.reload()};document.querySelectorAll('input[name=caption]').forEach(e=>e.onchange=async()=>{await fetch('/photos',{method:'POST',body:JSON.stringify({id:'${id}',action:'caption',photoId:e.closest('[data-image_id]').dataset.image_id,caption:e.value})})});let dragged;document.querySelectorAll('.sortable-handle').forEach(e=>{e.ondragstart=()=>{dragged=e.closest('[data-image_id]')};e.ondragover=x=>x.preventDefault();e.ondrop=x=>{x.preventDefault();const target=e.closest('[data-image_id]');target.before(dragged)}});`,
        ),
      );
      return;
    }
    if (url.pathname === "/my-profile.html") {
      html(
        page(
          `<img id="profile_image_element" src="/profile-${state.profilePhoto}.png"><form id="profile_form"><input name="first_name" value="${escapeHtml(state.profile.first_name || "")}"><input name="last_name" value="${escapeHtml(state.profile.last_name || "")}"><select name="title"><option value="1" ${state.profile.title === "1" ? "selected" : ""}>Option one</option><option value="2" ${state.profile.title === "2" ? "selected" : ""}>Option two</option></select><input type="tel" name="telephone_main" value="${escapeHtml(state.profile.telephone_main || "")}"><button type="submit">Speichern</button></form><input type="file" id="profile-image"><button id="save_edited_image" style="display:none">Speichern</button>`,
          `profile_form.onsubmit=async e=>{e.preventDefault();await fetch('/save-profile',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(profile_form)))})};document.getElementById('profile-image').onchange=()=>{document.getElementById('save_edited_image').style.display='block'};save_edited_image.onclick=async()=>{await fetch('/upload',{method:'POST',body:'image'});profile_image_element.src='/profile-${state.profilePhoto + 1}.png'};`,
        ),
      );
      return;
    }
    if (url.pathname === "/nachrichten.html") {
      const page2 = url.searchParams.get("page") === "2";
      html(
        page(
          `<div class="panel-body ${page2 ? "" : "conversation_unread"}" data-conversation_id="${page2 ? "202" : "201"}" data-message_id="1"><a class="link-conversation-list" href="/nachricht.html?nachrichten-id=201"><span class="user_name">Example person</span><span class="latest_message">Synthetic preview</span></a></div><div class="pagination"><a href="?page=1">1</a><a href="?page=2">2</a></div>`,
        ),
      );
      return;
    }
    if (/\.999\.html$/.test(url.pathname)) {
      html(page('<a href="/nachricht-senden.html?ad_id=999">Nachricht senden</a>'));
      return;
    }
    if (url.pathname === "/nachricht-senden.html") {
      html(
        page(
          '<div id="start_new_conversation"><input type="hidden" name="ad_id" value="999"><textarea id="message_input" name="content"></textarea><button class="create_new_conversation">Senden</button></div><div id="message_successfully_sent" style="display:none"><a href="/nachricht.html?nachrichten-id=201">Open conversation</a></div>',
          `document.querySelector('.create_new_conversation').onclick=async()=>{await fetch('/send',{method:'POST',body:JSON.stringify({text:message_input.value})});start_new_conversation.style.display='none';message_successfully_sent.style.display='block'};`,
        ),
      );
      return;
    }
    if (url.pathname === "/nachricht.html") {
      const messages = state.messages
        .map(
          (m) =>
            `<div class="message ${m.outgoing ? "my_message" : ""}" id="last_message_id_${m.id}"><div class="message_text">${escapeHtml(m.text)}</div></div>${m.outgoing ? '<div class="text_delivery_message">Sent</div>' : ""}`,
        )
        .join("");
      html(
        page(
          `<input type="hidden" id="conversation_id" value="201"><div id="messages_container">${messages}</div><a class="download_attachment_conversation" data-file_id="301" data-message_id="1" href="/user-files.html?file_id=301" download="fixture.txt">fixture.txt</a><form id="message_input_container"><textarea id="message_input" name="content"></textarea><input type="file" id="file_input"><button type="button" class="send_messages">Senden</button></form>`,
          `file_input.onchange=async()=>{const r=await fetch('/upload',{method:'POST',body:'synthetic bytes'});const f=await r.json();const e=document.createElement('div');e.className='pre_attached_file';e.dataset.file_id=f.id;message_input_container.append(e)};document.querySelector('.send_messages').onclick=async()=>{const r=await fetch('/send',{method:'POST',body:JSON.stringify({text:message_input.value})});const m=await r.json();const e=document.createElement('div');e.className='message my_message';const t=document.createElement('div');t.className='message_content';t.textContent=m.text;e.append(t);messages_container.append(e);const sent=document.createElement('div');sent.className='text_delivery_message';sent.textContent='Sent';messages_container.append(sent);message_input.value='';document.querySelectorAll('.pre_attached_file').forEach(e=>e.remove())};`,
        ),
      );
      return;
    }
    response.writeHead(404).end("Missing synthetic fixture route");
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const config: Config = {
    accounts: [
      { id: "a", emailEnv: "A_EMAIL", passwordEnv: "A_PASSWORD" },
      { id: "b", emailEnv: "B_EMAIL", passwordEnv: "B_PASSWORD" },
    ],
    dataDir: directory,
    attachmentRoots: [directory],
    readOnly: false,
    headless: true,
    browserChannel: process.env.WG_MCP_TEST_BROWSER_CHANNEL || "chromium",
    timeoutMs: 4000,
    baseUrl,
    env: {
      A_EMAIL: "a@example.test",
      A_PASSWORD: "synthetic",
      B_EMAIL: "b@example.test",
      B_PASSWORD: "synthetic",
    },
  };
  return {
    config,
    state: (id = "a") => getState(id),
    directory,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await rm(directory, { recursive: true, force: true });
    },
  };
}
