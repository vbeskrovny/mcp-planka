/**
 * Live attachment test against a real Planka server. Opt-in:
 *   PLANKA_INTEGRATION=1 PLANKA_TEST_BOARD_ID=<board id> npm run test:int
 * Works on a card in a temporary list it creates, and deletes card and list afterwards.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlankaClient } from "../../src/client.js";
import { loadConfig } from "../../src/config.js";
import { connect } from "../helpers.js";

const enabled = process.env.PLANKA_INTEGRATION === "1" && !!process.env.PLANKA_TEST_BOARD_ID;
const BOARD = process.env.PLANKA_TEST_BOARD_ID!;
// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe.runIf(enabled)("live attachments", () => {
  let api: PlankaClient;
  let mcp: Awaited<ReturnType<typeof connect>>;
  let listId: string;
  let cardId: string;
  const ids: Record<string, string> = {};
  const tag = `mcp-att-${Date.now()}`;
  const tmp = mkdtempSync(join(tmpdir(), "planka-att-it-"));

  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await mcp.call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.text}`);
    return r.data;
  };

  beforeAll(async () => {
    const cfg = loadConfig();
    api = new PlankaClient(cfg.url, cfg.apiKey);
    mcp = await connect(api);
    listId = (await ok("planka_create_list", { boardId: BOARD, name: `MCP test ${tag}`, position: "bottom" })).id;
    cardId = (await ok("planka_create_card", { listId, name: `Attachments ${tag}` })).id;
  });

  afterAll(async () => {
    if (cardId) await api.delete(`/cards/${cardId}`).catch((e) => console.error(`cleanup card: ${e.message}`));
    if (listId) await api.delete(`/lists/${listId}`).catch((e) => console.error(`cleanup list: ${e.message}`));
    rmSync(tmp, { recursive: true, force: true });
  });

  it("uploads a local text file", async () => {
    const src = join(tmp, "notes.txt");
    writeFileSync(src, `hello from ${tag}\n`);
    const a = await ok("planka_add_attachment", { cardId, filePath: src });
    expect(a).toMatchObject({ type: "file", name: "notes.txt" });
    expect(a.url).toMatch(/\/attachments\/\d+\/download\//);
    ids.text = a.id;
  });

  it("uploads an image from base64 and sets it as the cover", async () => {
    const a = await ok("planka_add_attachment", { cardId, content: PNG.toString("base64"), filename: "dot.png", setAsCover: true });
    expect(a).toMatchObject({ type: "file", isCover: true });
    ids.image = a.id;
  });

  it("adds a link", async () => {
    const a = await ok("planka_add_attachment", { cardId, url: "https://planka.app/" });
    expect(a).toMatchObject({ type: "link", name: "planka.app" });
    ids.link = a.id;
  });

  it("lists them on the card, with the cover", async () => {
    const r = await ok("planka_list_attachments", { cardId });
    expect(r.coverAttachmentId).toBe(ids.image);
    expect(r.attachments.map((a: any) => a.id).sort()).toEqual([ids.text, ids.image, ids.link].sort());
    const card = await ok("planka_get_card", { cardId });
    expect(card.attachments.find((a: any) => a.id === ids.image).isCover).toBe(true);
  });

  it("downloads text inline and to a file (API key works for downloads)", async () => {
    const r: any = await mcp.client.callTool({ name: "planka_download_attachment", arguments: { cardId, attachmentId: ids.text } });
    expect(r.isError).toBeFalsy();
    expect(r.content[1].text).toBe(`hello from ${tag}\n`);
    const out = join(tmp, "out");
    mkdirSync(out);
    const saved = await ok("planka_download_attachment", { cardId, attachmentId: ids.text, savePath: out + "/" });
    expect(saved.savedTo).toBe(join(out, "notes.txt"));
    expect(readFileSync(saved.savedTo, "utf8")).toBe(`hello from ${tag}\n`);
  });

  it("downloads the image as image content", async () => {
    const r: any = await mcp.client.callTool({ name: "planka_download_attachment", arguments: { cardId, attachmentId: ids.image } });
    expect(r.content[1].type).toBe("image");
    expect(Buffer.from(r.content[1].data, "base64").subarray(1, 4).toString()).toBe("PNG");
  });

  it("renames, clears the cover, and deletes", async () => {
    expect((await ok("planka_rename_attachment", { attachmentId: ids.text, name: "Renamed notes" })).name).toBe("Renamed notes");
    expect((await ok("planka_update_card", { cardId, coverAttachmentId: null })).coverAttachmentId).toBeNull();
    for (const k of ["text", "image", "link"]) {
      expect((await ok("planka_delete_attachment", { attachmentId: ids[k] })).deleted).toBe(true);
    }
    expect((await ok("planka_list_attachments", { cardId })).attachments).toEqual([]);
  });
});
