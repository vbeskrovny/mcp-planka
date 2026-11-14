import { describe, expect, it } from "vitest";
import { connect, echoItem, fakePlanka, type Call } from "../helpers.js";

const LIST = "200";
const BOARD = "100";
const listResp = {
  item: { id: LIST, boardId: BOARD, name: "Todo" },
  included: {
    cards: [
      { id: "301", listId: LIST, position: 65536 },
      { id: "302", listId: LIST, position: 131072 },
    ],
  },
};
const boardResp = {
  item: { id: BOARD, name: "B", projectId: "1", defaultCardType: "story" },
  included: {
    lists: [
      { id: LIST, position: 65536, type: "active" },
      { id: "201", position: 131072, type: "closed" },
      { id: "209", position: null, type: "trash" },
    ],
    labels: [{ id: "400", position: 65536 }],
  },
};

describe("tool registry", () => {
  it("registers all tools with correct annotations", async () => {
    const { client } = await connect(fakePlanka({}).client);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "planka_whoami", "planka_list_projects", "planka_get_board", "planka_get_card", "planka_search_cards",
        "planka_create_list", "planka_update_list", "planka_move_list",
        "planka_create_card", "planka_update_card", "planka_move_card", "planka_delete_card",
        "planka_add_comment", "planka_update_comment", "planka_delete_comment",
        "planka_create_task_list", "planka_add_task", "planka_update_task", "planka_delete_task",
        "planka_create_label", "planka_add_label_to_card", "planka_remove_label_from_card",
        "planka_check_updates", "planka_sync_board_members",
        "planka_find_project", "planka_create_project", "planka_create_board", "planka_update_project",
        "planka_delete_list", "planka_delete_board", "planka_delete_project",
        "planka_list_attachments", "planka_add_attachment", "planka_rename_attachment",
        "planka_delete_attachment", "planka_download_attachment",
      ].sort(),
    );
    for (const t of tools) {
      if (/^planka_(get|list|search|whoami|find)/.test(t.name)) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      if (/delete/.test(t.name)) expect(t.annotations?.destructiveHint, t.name).toBe(true);
      expect(t.description, t.name).toBeTruthy();
    }
  });
});

describe("cards", () => {
  it("create_card: board default type, bottom position", async () => {
    const f = fakePlanka({
      [`GET /lists/${LIST}`]: listResp,
      [`GET /boards/${BOARD}`]: boardResp,
      [`POST /lists/${LIST}/cards`]: echoItem({ listId: LIST, boardId: BOARD }),
    });
    const { call } = await connect(f.client);
    const r = await call("planka_create_card", { listId: LIST, name: "New", description: "d" });
    expect(r.isError).toBe(false);
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ type: "story", name: "New", description: "d", position: 131072 + 65536 });
  });

  it("create_card: explicit type skips board fetch; top position", async () => {
    const f = fakePlanka({ [`GET /lists/${LIST}`]: listResp, [`POST /lists/${LIST}/cards`]: echoItem() });
    const { call } = await connect(f.client);
    await call("planka_create_card", { listId: LIST, name: "N", type: "project", position: "top" });
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /lists/${LIST}`, `POST /lists/${LIST}/cards`]);
    expect(f.calls[1].body).toMatchObject({ type: "project", position: 32768 });
  });

  it("update_card: sends only provided fields, allows null to clear", async () => {
    const f = fakePlanka({ "PATCH /cards/301": echoItem() });
    const { call } = await connect(f.client);
    await call("planka_update_card", { cardId: "301", name: "R", dueDate: null });
    expect(f.calls[0].body).toEqual({ name: "R", dueDate: null });
  });

  it("update_card: rejects empty update without calling the API", async () => {
    const f = fakePlanka({});
    const { call } = await connect(f.client);
    const r = await call("planka_update_card", { cardId: "301" });
    expect(r.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });

  it("move_card: within board, excludes itself from position math", async () => {
    const f = fakePlanka({
      "GET /cards/302": { item: { id: "302", boardId: BOARD, listId: LIST } },
      [`GET /lists/${LIST}`]: listResp,
      "PATCH /cards/302": echoItem(),
    });
    const { call } = await connect(f.client);
    await call("planka_move_card", { cardId: "302", listId: LIST, position: "top" });
    expect(f.calls.at(-1)!.body).toEqual({ listId: LIST, position: 32768 });
  });

  it("move_card: across boards adds boardId", async () => {
    const f = fakePlanka({
      "GET /cards/302": { item: { id: "302", boardId: "555" } },
      [`GET /lists/${LIST}`]: listResp,
      "PATCH /cards/302": echoItem(),
    });
    const { call } = await connect(f.client);
    await call("planka_move_card", { cardId: "302", listId: LIST });
    expect(f.calls.at(-1)!.body).toMatchObject({ listId: LIST, boardId: BOARD });
  });

  it("delete_card", async () => {
    const f = fakePlanka({ "DELETE /cards/301": { item: { id: "301", name: "x" } } });
    const { call } = await connect(f.client);
    expect((await call("planka_delete_card", { cardId: "301" })).data).toEqual({ deleted: true, id: "301", name: "x" });
  });
});

describe("validation", () => {
  it("rejects non-numeric IDs before any request", async () => {
    const f = fakePlanka({});
    const { call } = await connect(f.client);
    const r = await call("planka_get_card", { cardId: "abc" });
    expect(r.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
  it("rejects unknown label colors", async () => {
    const f = fakePlanka({});
    const { call } = await connect(f.client);
    const r = await call("planka_create_label", { boardId: BOARD, name: "x", color: "red" });
    expect(r.isError).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
  it("surfaces Planka errors as tool errors", async () => {
    const f = fakePlanka({});
    const { call } = await connect(f.client);
    const r = await call("planka_add_comment", { cardId: "1", text: "hi" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("404");
    expect(r.text).not.toContain("TESTKEY");
  });
});

describe("lists", () => {
  it("create_list ignores trash/archive positions", async () => {
    const f = fakePlanka({ [`GET /boards/${BOARD}`]: boardResp, [`POST /boards/${BOARD}/lists`]: echoItem() });
    const { call } = await connect(f.client);
    await call("planka_create_list", { boardId: BOARD, name: "QA" });
    expect(f.calls[1].body).toEqual({ type: "active", name: "QA", position: 131072 + 65536 });
  });
  it("update_list rename only (no extra fetches)", async () => {
    const f = fakePlanka({ [`PATCH /lists/${LIST}`]: echoItem() });
    const { call } = await connect(f.client);
    await call("planka_update_list", { listId: LIST, name: "Doing" });
    expect(f.calls).toEqual([{ method: "PATCH", path: `/lists/${LIST}`, body: { name: "Doing" } }]);
  });
});

describe("comments", () => {
  it("add / update / delete", async () => {
    const f = fakePlanka({
      "POST /cards/1/comments": echoItem({ cardId: "1" }),
      "PATCH /comments/5": echoItem(),
      "DELETE /comments/5": { item: { id: "5" } },
    });
    const { call } = await connect(f.client);
    expect((await call("planka_add_comment", { cardId: "1", text: "hello" })).data).toMatchObject({ cardId: "1", text: "hello" });
    await call("planka_update_comment", { commentId: "5", text: "edited" });
    await call("planka_delete_comment", { commentId: "5" });
    expect(f.calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/cards/1/comments", { text: "hello" }],
      ["PATCH", "/comments/5", { text: "edited" }],
      ["DELETE", "/comments/5", undefined],
    ]);
  });
});

describe("tasks", () => {
  it("create_task_list with initial tasks", async () => {
    let n = 0;
    const f = fakePlanka({
      "GET /cards/1": { item: { id: "1" }, included: { taskLists: [{ id: "60", position: 65536 }] } },
      "POST /cards/1/task-lists": echoItem({ id: "61", cardId: "1" }),
      "POST /task-lists/61/tasks": (c: Call) => ({ item: { id: String(70 + ++n), taskListId: "61", ...c.body } }),
    });
    const { call } = await connect(f.client);
    const r = await call("planka_create_task_list", { cardId: "1", name: "QA", tasks: ["a", "b"] });
    expect(f.calls[1].body).toEqual({ name: "QA", position: 131072 });
    expect(r.data.tasks).toEqual([
      { id: "71", taskListId: "61", name: "a", done: false },
      { id: "72", taskListId: "61", name: "b", done: false },
    ]);
  });
  it("add_task computes position; update_task toggles", async () => {
    const f = fakePlanka({
      "GET /task-lists/61": { item: { id: "61" }, included: { tasks: [{ position: 65536 }] } },
      "POST /task-lists/61/tasks": echoItem({ taskListId: "61" }),
      "PATCH /tasks/71": echoItem({ id: "71" }),
      "DELETE /tasks/71": { item: { id: "71" } },
    });
    const { call } = await connect(f.client);
    await call("planka_add_task", { taskListId: "61", name: "c", isCompleted: true });
    expect(f.calls[1].body).toEqual({ name: "c", position: 131072, isCompleted: true });
    expect((await call("planka_update_task", { taskId: "71", isCompleted: true })).data.done).toBe(true);
    expect((await call("planka_delete_task", { taskId: "71" })).data).toEqual({ deleted: true, id: "71" });
  });
});

describe("labels", () => {
  it("create label at bottom; add/remove on card uses v2 routes", async () => {
    const f = fakePlanka({
      [`GET /boards/${BOARD}`]: boardResp,
      [`POST /boards/${BOARD}/labels`]: echoItem({ boardId: BOARD }),
      "POST /cards/1/card-labels": echoItem({ cardId: "1" }),
      "DELETE /cards/1/card-labels/labelId:400": { item: {} },
    });
    const { call } = await connect(f.client);
    await call("planka_create_label", { boardId: BOARD, name: "bug", color: "berry-red" });
    expect(f.calls[1].body).toEqual({ name: "bug", color: "berry-red", position: 131072 });
    expect((await call("planka_add_label_to_card", { cardId: "1", labelId: "400" })).data).toEqual({ cardId: "1", labelId: "400" });
    expect((await call("planka_remove_label_from_card", { cardId: "1", labelId: "400" })).isError).toBe(false);
    expect(f.calls.at(-1)!.path).toBe("/cards/1/card-labels/labelId:400");
  });
});

describe("move_list", () => {
  const routes = (role: string | null, overrides: Record<string, unknown> = {}) => ({
    "GET /users/me": { item: { id: "1" } },
    "GET /lists/200": { item: { id: "200", boardId: BOARD, name: "Todo", type: "active" }, included: { cards: [{ id: "a" }, { id: "b" }] } },
    "GET /boards/500": {
      item: { id: "500", name: "Target", projectId: "77" },
      included: {
        projects: [{ id: "77", name: "Other project" }],
        lists: [{ id: "600", position: 65536, type: "active" }, { id: "699", position: null, type: "trash" }],
        boardMemberships: role ? [{ userId: "1", role }] : [],
      },
    },
    "PATCH /lists/200": echoItem({ id: "200", name: "Todo", type: "active" }),
    ...overrides,
  });

  it("moves to another board (other project) at the bottom", async () => {
    const f = fakePlanka(routes("editor"));
    const { call } = await connect(f.client);
    const r = await call("planka_move_list", { listId: "200", boardId: "500" });
    expect(r.isError).toBe(false);
    expect(f.calls.at(-1)).toEqual({ method: "PATCH", path: "/lists/200", body: { boardId: "500", position: 131072 } });
    expect(r.data).toMatchObject({
      fromBoardId: BOARD,
      board: { id: "500", name: "Target" },
      project: { id: "77", name: "Other project" },
      cardsMoved: 2,
    });
  });

  it("supports top position", async () => {
    const f = fakePlanka(routes("editor"));
    const { call } = await connect(f.client);
    await call("planka_move_list", { listId: "200", boardId: "500", position: "top" });
    expect(f.calls.at(-1)!.body).toEqual({ boardId: "500", position: 32768 });
  });

  it("refuses when the API-key user is only a viewer or not a member", async () => {
    for (const role of ["viewer", null]) {
      const f = fakePlanka(routes(role));
      const { call } = await connect(f.client);
      const r = await call("planka_move_list", { listId: "200", boardId: "500" });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(role ? /a viewer/ : /not a member/);
      expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
    }
  });

  it("gives a clear error when the target board is inaccessible", async () => {
    const f = fakePlanka({ ...routes("editor"), "GET /boards/500": undefined });
    const { call } = await connect(f.client);
    const r = await call("planka_move_list", { listId: "200", boardId: "500" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not found or not accessible");
  });

  it("rejects same-board moves and archive/trash lists", async () => {
    const same = fakePlanka(routes("editor"));
    const { call } = await connect(same.client);
    expect((await call("planka_move_list", { listId: "200", boardId: BOARD })).text).toContain("planka_update_list");
    const trash = fakePlanka(routes("editor", { "GET /lists/200": { item: { id: "200", boardId: BOARD, type: "trash" } } }));
    const c2 = await connect(trash.client);
    expect((await c2.call("planka_move_list", { listId: "200", boardId: "500" })).text).toContain("trash");
  });
});
