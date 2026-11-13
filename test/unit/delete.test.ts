import { describe, expect, it } from "vitest";
import { connect, fakePlanka } from "../helpers.js";

const ME = "1";
const del = { item: {} };

function routes(opts: { manager?: boolean; role?: string } = {}) {
  const { manager = true, role = "editor" } = opts;
  return {
    "GET /users/me": { item: { id: ME } },
    "GET /lists/200": { item: { id: "200", boardId: "100", name: "Todo", type: "active" }, included: { cards: [{ id: "a" }, { id: "b" }] } },
    "GET /lists/299": { item: { id: "299", boardId: "100", name: null, type: "trash" } },
    "GET /boards/100": {
      item: { id: "100", name: "Dev", projectId: "10" },
      included: {
        projects: [{ id: "10", name: "Proj" }],
        lists: [
          { id: "200", type: "active" },
          { id: "201", type: "closed" },
          { id: "299", type: "trash" },
        ],
        cards: [
          { id: "a", listId: "200" },
          { id: "b", listId: "200" },
          { id: "c", listId: "201" },
        ],
        boardMemberships: [
          { id: "m-me", userId: ME, role },
          { id: "m-bb", userId: "2", role: "editor" },
        ],
      },
    },
    "GET /boards/101": {
      item: { id: "101", name: "Ops", projectId: "10" },
      included: { lists: [{ id: "210", type: "active" }], cards: [], boardMemberships: [{ id: "m2-me", userId: ME, role: "editor" }] },
    },
    "GET /projects": {
      items: [{ id: "10", name: "Proj" }, { id: "11", name: "Empty" }],
      included: {
        boards: [{ id: "100", projectId: "10", name: "Dev" }, { id: "101", projectId: "10", name: "Ops" }],
        projectManagers: manager ? [{ projectId: "10", userId: ME }] : [],
      },
    },
    "DELETE /lists/200": del,
    "DELETE /lists/201": del,
    "DELETE /lists/210": del,
    "DELETE /cards/a": del,
    "DELETE /cards/b": del,
    "DELETE /cards/c": del,
    "POST /lists/299/clear": del,
    "DELETE /board-memberships/m-me": del,
    "DELETE /board-memberships/m-bb": del,
    "DELETE /board-memberships/m2-me": del,
    "DELETE /boards/100": del,
    "DELETE /boards/101": del,
    "DELETE /projects/10": del,
    "DELETE /projects/11": del,
  };
}
const writes = (f: ReturnType<typeof fakePlanka>) =>
  f.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);

describe("delete tools", () => {
  it("delete_list: preview without confirm, deletes with exact name", async () => {
    const f = fakePlanka(routes());
    const { call } = await connect(f.client);
    const p = await call("planka_delete_list", { listId: "200" });
    expect(p.data).toMatchObject({ deleted: false, preview: true, wouldDelete: { kind: "list", name: "Todo", board: "Dev", cards: 2 } });
    expect(writes(f)).toEqual([]);
    expect((await call("planka_delete_list", { listId: "200", confirm: "Todo" })).data.deleted).toBe(true);
    expect(writes(f)).toEqual(["DELETE /lists/200"]);
  });

  it("wrong confirmation deletes nothing", async () => {
    const f = fakePlanka(routes());
    const { call } = await connect(f.client);
    for (const [tool, args] of [
      ["planka_delete_list", { listId: "200", confirm: "todo" }],
      ["planka_delete_board", { boardId: "100", confirm: "yes" }],
      ["planka_delete_project", { projectId: "11", confirm: "Proj" }],
    ] as const) {
      const r = await call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.text).toContain("Nothing was deleted");
    }
    expect(writes(f)).toEqual([]);
  });

  it("refuses to delete trash/archive lists", async () => {
    const f = fakePlanka(routes());
    const { call } = await connect(f.client);
    expect((await call("planka_delete_list", { listId: "299", confirm: "299" })).text).toContain("cannot be deleted");
    expect(writes(f)).toEqual([]);
  });

  it("delete_board: preview shows counts and the steps", async () => {
    const f = fakePlanka(routes());
    const { call } = await connect(f.client);
    const p = await call("planka_delete_board", { boardId: "100" });
    expect(p.data.wouldDelete).toMatchObject({ name: "Dev", project: "Proj", lists: 2, cards: 3, members: 2 });
    expect(p.data.wouldDelete.steps).toHaveLength(4);
    expect(writes(f)).toEqual([]);
  });

  it("delete_board: tears down in order: cards, trash, lists, members (me last), board", async () => {
    const f = fakePlanka(routes());
    const { call } = await connect(f.client);
    const r = await call("planka_delete_board", { boardId: "100", confirm: "Dev" });
    expect(r.isError).toBe(false);
    expect(writes(f)).toEqual([
      "DELETE /cards/a",
      "DELETE /cards/b",
      "DELETE /cards/c",
      "POST /lists/299/clear",
      "DELETE /lists/200",
      "DELETE /lists/201",
      "DELETE /board-memberships/m-bb",
      "DELETE /board-memberships/m-me",
      "DELETE /boards/100",
    ]);
    expect(r.data.teardown).toEqual({
      board: "Dev",
      cardsDeleted: 3,
      trashCleared: true,
      listsDeleted: 2,
      membersRemoved: 2,
      boardDeleted: true,
    });
  });

  it("delete_board: refuses up front without project manager or editor rights", async () => {
    for (const [opts, msg] of [
      [{ manager: false }, "project manager"],
      [{ role: "viewer" }, "editor of the board"],
    ] as const) {
      const f = fakePlanka(routes(opts));
      const { call } = await connect(f.client);
      for (const confirm of [undefined, "Dev"]) {
        const r = await call("planka_delete_board", { boardId: "100", ...(confirm ? { confirm } : {}) });
        expect(r.isError).toBe(true);
        expect(r.text).toContain(msg);
      }
      expect(writes(f)).toEqual([]);
    }
  });

  it("delete_board: reports the step and progress when a step fails", async () => {
    const f = fakePlanka({ ...routes(), "DELETE /lists/201": undefined });
    const { call } = await connect(f.client);
    const r = await call("planka_delete_board", { boardId: "100", confirm: "Dev" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('stopped at "delete lists"');
    expect(r.text).toContain('"cardsDeleted":3');
    expect(writes(f)).not.toContain("DELETE /boards/100");
  });

  it("delete_project: refuses with boards unless deleteBoards, then tears down each board first", async () => {
    const f = fakePlanka(routes());
    const { call } = await connect(f.client);
    const p = await call("planka_delete_project", { projectId: "10" });
    expect(p.data.wouldDelete.boards).toEqual([
      { id: "100", name: "Dev", cards: 3 },
      { id: "101", name: "Ops", cards: 0 },
    ]);
    expect(p.data.wouldDelete.note).toContain("deleteBoards: true");
    expect((await call("planka_delete_project", { projectId: "10", confirm: "Proj" })).isError).toBe(true);
    expect(writes(f)).toEqual([]);
    const ok = await call("planka_delete_project", { projectId: "10", deleteBoards: true, confirm: "Proj" });
    expect(ok.data.deleted).toBe(true);
    expect(ok.data.teardown.map((t: any) => t.board)).toEqual(["Dev", "Ops"]);
    const w = writes(f);
    expect(w.indexOf("DELETE /boards/100")).toBeLessThan(w.indexOf("DELETE /lists/210"));
    expect(w.slice(-3)).toEqual(["DELETE /board-memberships/m2-me", "DELETE /boards/101", "DELETE /projects/10"]);
  });

  it("delete_project: empty project, unknown project", async () => {
    const f = fakePlanka(routes());
    const { call } = await connect(f.client);
    await call("planka_delete_project", { projectId: "11", confirm: "Empty" });
    expect(writes(f)).toEqual(["DELETE /projects/11"]);
    expect((await call("planka_delete_project", { projectId: "99" })).text).toContain("not found");
  });

  it("delete tools are marked destructive", async () => {
    const { client } = await connect(fakePlanka({}).client);
    const tools = (await client.listTools()).tools.filter((t) => /delete_(list|board|project)/.test(t.name));
    expect(tools).toHaveLength(3);
    for (const t of tools) expect(t.annotations?.destructiveHint).toBe(true);
  });
});
