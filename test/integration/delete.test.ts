/**
 * Live test for the delete tools. Creates its own temporary project (the API-key user becomes
 * its only manager), so nothing existing is touched. Opt-in: PLANKA_INTEGRATION=1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlankaClient } from "../../src/client.js";
import { loadConfig } from "../../src/config.js";
import { connect } from "../helpers.js";

describe.runIf(process.env.PLANKA_INTEGRATION === "1")("live delete tools", () => {
  let api: PlankaClient;
  let call: Awaited<ReturnType<typeof connect>>["call"];
  const tag = `mcp-del-${Date.now()}`;
  let project: any;

  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.text}`);
    return r.data;
  };

  beforeAll(async () => {
    const cfg = loadConfig();
    api = new PlankaClient(cfg.url, cfg.apiKey);
    ({ call } = await connect(api, { managers: cfg.managers }));
    project = await ok("planka_create_project", { name: `MCP test ${tag}` });
  });

  afterAll(async () => {
    // Safety net if a test failed midway.
    const left = (await api.get("/projects")).items.find((p: any) => p.id === project?.id);
    if (left) {
      await call("planka_delete_project", { projectId: project.id, deleteBoards: true, confirm: left.name });
    }
  });

  it("create_project made a private project with the default board", () => {
    expect(project.board.lists.map((l: any) => l.name)).toEqual(["Backlog", "In Progress", "Testing", "Done"]);
    expect(project.type).toBe("private");
  });

  it("update_project: rename, description, hide and back", async () => {
    const renamed = `${project.name} renamed`;
    const u = await ok("planka_update_project", { projectId: project.id, name: renamed, description: "temp", hidden: true });
    expect(u).toMatchObject({ name: renamed, description: "temp", isHidden: true, type: "private" });
    const back = await ok("planka_update_project", { projectId: project.id, name: project.name, description: null, hidden: false });
    expect(back).toMatchObject({ name: project.name, description: null, isHidden: false });
  });

  it("delete_list: preview keeps the list, confirm moves cards to trash", async () => {
    const listId = project.board.lists[2].id;
    const card = await ok("planka_create_card", { listId, name: "goes to trash" });
    const p = await ok("planka_delete_list", { listId });
    expect(p).toMatchObject({ deleted: false, wouldDelete: { name: "Testing", cards: 1 } });
    expect((await ok("planka_get_board", { boardId: project.board.id })).lists.some((l: any) => l.id === listId)).toBe(true);

    expect((await call("planka_delete_list", { listId, confirm: "testing" })).isError).toBe(true);
    expect((await ok("planka_delete_list", { listId, confirm: "Testing" })).deleted).toBe(true);
    const board = await ok("planka_get_board", { boardId: project.board.id, includeArchived: true });
    expect(board.lists.some((l: any) => l.id === listId)).toBe(false);
    // The board view doesn't include trashed cards; the card itself still exists in the Trash list.
    const trashed = await ok("planka_get_card", { cardId: card.id });
    expect(trashed.list.type).toBe("trash");
  });

  it("delete_board: preview, then staged teardown (cards, lists, members, board)", async () => {
    const extra = await ok("planka_create_board", { projectId: project.id, name: "Extra", lists: ["One", "Two"] });
    await ok("planka_create_card", { listId: extra.lists[0].id, name: "c1" });
    await ok("planka_create_card", { listId: extra.lists[1].id, name: "c2" });
    const members = 1 + (extra.editors?.length ?? 0);
    const p = await ok("planka_delete_board", { boardId: extra.id });
    expect(p.wouldDelete).toMatchObject({ name: "Extra", lists: 2, cards: 2, members });
    const d = await ok("planka_delete_board", { boardId: extra.id, confirm: "Extra" });
    expect(d.teardown).toEqual({
      board: "Extra",
      cardsDeleted: 2,
      trashCleared: true,
      listsDeleted: 2,
      membersRemoved: members,
      boardDeleted: true,
    });
    expect((await call("planka_get_board", { boardId: extra.id })).isError).toBe(true);
  });

  it("delete_project: refuses with boards, deletes with deleteBoards + confirm", async () => {
    const p = await ok("planka_delete_project", { projectId: project.id });
    expect(p.wouldDelete.boards.map((b: any) => b.name)).toEqual(["Development"]);
    expect((await call("planka_delete_project", { projectId: project.id, confirm: project.name })).isError).toBe(true);
    const d = await ok("planka_delete_project", { projectId: project.id, deleteBoards: true, confirm: project.name });
    expect(d.deleted).toBe(true);
    expect((await ok("planka_find_project", { name: project.name })).matches).toEqual([]);
  });

  it("create_project: private, invisible as shared, MANAGERS become board editors", async () => {
    const managers = loadConfig().managers;
    // Passing type: "shared" must be ignored: there is no shared option.
    const p = await ok("planka_create_project", { name: `MCP test ${tag} mgr`, type: "shared" });
    try {
      expect(p.type).toBe("private");
      const live = (await api.get("/projects")).items.find((x: any) => x.id === p.id);
      expect(live.ownerProjectManagerId).toBeTruthy();
      expect(p.boardEditors.length).toBe(managers.length);
      const board = await api.get(`/boards/${p.board.id}`);
      expect(board.included.boardMemberships.filter((m: any) => m.role === "editor").length).toBe(1 + managers.length);
    } finally {
      await ok("planka_delete_project", { projectId: p.id, deleteBoards: true, confirm: p.name });
    }
  });
});
