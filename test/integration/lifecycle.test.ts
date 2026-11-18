/**
 * Live integration test against a real Planka server. Opt-in:
 *   MCP_APP_PLANKA_INTEGRATION=1 MCP_APP_PLANKA_TEST_BOARD_ID=<board id> npm run test:int
 * Works only inside a temporary list it creates, and deletes that list afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlankaClient } from "../../src/client.js";
import { loadConfig } from "../../src/config.js";
import { connect } from "../helpers.js";

const enabled = process.env.MCP_APP_PLANKA_INTEGRATION === "1" && !!process.env.MCP_APP_PLANKA_TEST_BOARD_ID;
const BOARD = process.env.MCP_APP_PLANKA_TEST_BOARD_ID!;

describe.runIf(enabled)("live lifecycle", () => {
  let api: PlankaClient;
  let call: Awaited<ReturnType<typeof connect>>["call"];
  let listId: string;
  let list2Id: string;
  const ctx: Record<string, string> = {};
  const tag = `mcp-it-${Date.now()}`;

  const ok = async (name: string, args: Record<string, unknown>) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name} failed: ${r.text}`);
    return r.data;
  };

  beforeAll(async () => {
    const cfg = loadConfig();
    api = new PlankaClient(cfg.url, cfg.apiKey);
    ({ call } = await connect(api));
    listId = (await ok("planka_create_list", { boardId: BOARD, name: `MCP test ${tag}`, position: "bottom" })).id;
    list2Id = (await ok("planka_create_list", { boardId: BOARD, name: `MCP test ${tag} B`, position: "bottom" })).id;
  });

  afterAll(async () => {
    if (ctx.tempBoard) {
      await api.delete(`/boards/${ctx.tempBoard}`).catch((e) => console.error(`cleanup failed for board: ${e.message}`));
    }
    for (const id of [listId, list2Id].filter(Boolean)) {
      await api.delete(`/lists/${id}`).catch((e) => console.error(`cleanup failed for list ${id}: ${e.message}`));
    }
  });

  it("whoami", async () => {
    expect((await ok("planka_whoami", {})).id).toMatch(/^\d+$/);
  });

  it("creates and reads a card", async () => {
    const card = await ok("planka_create_card", { listId, name: `Card ${tag}`, description: "integration **test**" });
    ctx.card = card.id;
    const second = await ok("planka_create_card", { listId, name: `Top ${tag}`, position: "top" });
    ctx.card2 = second.id;
    expect(second.position).toBeLessThan(card.position);
    const full = await ok("planka_get_card", { cardId: ctx.card });
    expect(full.description).toBe("integration **test**");
    expect(full.list.id).toBe(listId);
  });

  it("updates the card", async () => {
    const r = await ok("planka_update_card", { cardId: ctx.card, name: `Card ${tag} v2`, dueDate: "2030-01-01T10:00:00Z" });
    expect(r.name).toBe(`Card ${tag} v2`);
    expect(r.dueDate).toMatch(/^2030-01-01/);
    expect((await ok("planka_update_card", { cardId: ctx.card, dueDate: null })).dueDate).toBeNull();
  });

  it("comments: add, update, read back, delete", async () => {
    const c = await ok("planka_add_comment", { cardId: ctx.card, text: "hello from integration" });
    await ok("planka_update_comment", { commentId: c.id, text: "edited" });
    const full = await ok("planka_get_card", { cardId: ctx.card });
    expect(full.comments.map((x: any) => x.text)).toContain("edited");
    await ok("planka_delete_comment", { commentId: c.id });
  });

  it("tasks: task list with tasks, add, toggle, delete", async () => {
    const tl = await ok("planka_create_task_list", { cardId: ctx.card, name: "Checks", tasks: ["one", "two"] });
    expect(tl.tasks).toHaveLength(2);
    const t3 = await ok("planka_add_task", { taskListId: tl.id, name: "three" });
    expect((await ok("planka_update_task", { taskId: t3.id, isCompleted: true })).done).toBe(true);
    await ok("planka_delete_task", { taskId: tl.tasks[0].id });
    const full = await ok("planka_get_card", { cardId: ctx.card });
    expect(full.taskLists[0].tasks.map((t: any) => [t.name, t.done])).toEqual([
      ["two", false],
      ["three", true],
    ]);
  });

  it("labels: create, attach, detach", async () => {
    const label = await ok("planka_create_label", { boardId: BOARD, name: tag, color: "sunny-grass" });
    ctx.label = label.id;
    await ok("planka_add_label_to_card", { cardId: ctx.card, labelId: label.id });
    expect((await ok("planka_get_card", { cardId: ctx.card })).labels.map((l: any) => l.id)).toContain(label.id);
    await ok("planka_remove_label_from_card", { cardId: ctx.card, labelId: label.id });
    expect((await ok("planka_get_card", { cardId: ctx.card })).labels ?? []).toHaveLength(0);
    await api.delete(`/labels/${label.id}`);
  });

  it("moves cards between lists and reorders", async () => {
    const moved = await ok("planka_move_card", { cardId: ctx.card, listId: list2Id });
    expect(moved.listId).toBe(list2Id);
    await ok("planka_move_card", { cardId: ctx.card2, listId: list2Id, position: "top" });
    const board = await ok("planka_get_board", { boardId: BOARD });
    const l2 = board.lists.find((l: any) => l.id === list2Id);
    expect(l2.cards.map((c: any) => c.id)).toEqual([ctx.card2, ctx.card]);
  });

  it("search finds the card", async () => {
    const r = await ok("planka_search_cards", { query: `Card ${tag} v2`, boardId: BOARD });
    expect(r.results.map((h: any) => h.cardId)).toContain(ctx.card);
  });

  it("renames list and deletes cards", async () => {
    expect((await ok("planka_update_list", { listId: list2Id, name: `MCP test ${tag} renamed` })).name).toContain("renamed");
    await ok("planka_delete_card", { cardId: ctx.card });
    await ok("planka_delete_card", { cardId: ctx.card2 });
    expect((await call("planka_get_card", { cardId: ctx.card })).isError).toBe(true);
  });

  it("moves a list with its cards to another board", async () => {
    const projectId = (await api.get(`/boards/${BOARD}`)).item.projectId;
    const board = await ok("planka_create_board", { projectId, name: `MCP test ${tag} board`, lists: ["Existing"] });
    ctx.tempBoard = board.id;
    const card = await ok("planka_create_card", { listId, name: `Travels ${tag}` });

    const r = await ok("planka_move_list", { listId, boardId: board.id, position: "top" });
    expect(r.board.id).toBe(board.id);
    expect(r.cardsMoved).toBe(1);

    const target = await ok("planka_get_board", { boardId: board.id });
    expect(target.lists.map((l: any) => l.name)).toEqual([`MCP test ${tag}`, "Existing"]);
    expect(target.lists[0].cards.map((c: any) => c.id)).toEqual([card.id]);
    expect((await ok("planka_get_board", { boardId: BOARD })).lists.some((l: any) => l.id === listId)).toBe(false);

    const same = await call("planka_move_list", { listId, boardId: board.id });
    expect(same.isError).toBe(true);
  });
});
