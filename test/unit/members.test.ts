import { describe, expect, it } from "vitest";
import { syncBoardMembers } from "../../src/tools/members.js";
import { connect, echoItem, fakePlanka } from "../helpers.js";

const routes = () => ({
  "GET /projects": {
    items: [{ id: "10" }, { id: "11" }],
    included: {
      users: [
        { id: "1", name: "Bot" },
        { id: "2", name: "Olga" },
      ],
      projectManagers: [
        { projectId: "10", userId: "1" },
        { projectId: "10", userId: "2" },
        { projectId: "11", userId: "3" },
      ],
      boards: [
        { id: "100", projectId: "10", name: "Dev" },
        { id: "101", projectId: "10", name: "Ops" },
        { id: "199", projectId: "11", name: "Other" },
      ],
    },
  },
  "GET /boards/100": { item: { id: "100" }, included: { boardMemberships: [{ userId: "1" }] } },
  "GET /boards/101": { item: { id: "101" }, included: { boardMemberships: [{ userId: "1" }, { userId: "2" }] } },
  "POST /boards/100/board-memberships": echoItem(),
});

describe("syncBoardMembers", () => {
  it("dry run by default: reports missing managers, writes nothing", async () => {
    const f = fakePlanka(routes());
    const r: any = await syncBoardMembers(f.client, "10");
    expect(r.dryRun).toBe(true);
    expect(r.wouldAdd).toEqual([{ boardId: "100", board: "Dev", userId: "2", user: "Olga", role: "editor" }]);
    expect(f.calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(f.calls.map((c) => c.path)).not.toContain("/boards/199");
  });

  it("applies with dryRun=false", async () => {
    const f = fakePlanka(routes());
    const r: any = await syncBoardMembers(f.client, "10", { dryRun: false, role: "viewer" });
    expect(r.added).toHaveLength(1);
    expect(f.calls.filter((c) => c.method === "POST")).toEqual([
      { method: "POST", path: "/boards/100/board-memberships", body: { userId: "2", role: "viewer" } },
    ]);
  });

  it("errors on unknown project; exposed as MCP tool defaulting to dry run", async () => {
    const f = fakePlanka(routes());
    await expect(syncBoardMembers(f.client, "999")).rejects.toThrow(/not found/);
    const { call } = await connect(f.client);
    const r = await call("planka_sync_board_members", { projectId: "10" });
    expect(r.data.dryRun).toBe(true);
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
  });
});
