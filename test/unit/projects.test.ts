import { describe, expect, it } from "vitest";
import { connect, fakePlanka, type Call } from "../helpers.js";

const projects = {
  items: [{ id: "10", name: "MCP-PLANKA" }, { id: "11", name: "Other" }],
  included: { boards: [{ id: "100", projectId: "10", name: "Development", position: 65536 }] },
};

describe("project tools", () => {
  it("find_project matches case-insensitively and includes boards", async () => {
    const { call } = await connect(fakePlanka({ "GET /projects": projects }).client);
    expect((await call("planka_find_project", { name: "mcp-planka" })).data.matches).toEqual([
      { id: "10", name: "MCP-PLANKA", boards: [{ id: "100", name: "Development" }] },
    ]);
    expect((await call("planka_find_project", { name: "nope" })).data.matches).toEqual([]);
  });

  const userRoutes = {
    "GET /users/me": { item: { id: "1" } },
    "GET /users": {
      items: [
        { id: "1", name: "bot@x", username: null },
        { id: "2", name: "alex@example.com", username: "alex" },
        { id: "3", name: "Carol", username: "carol", email: "carol@x" },
      ],
    },
  };

  /** MCP client against a server configured with MANAGERS. */
  async function connectWithManagers(planka: any, managers: string[]) {
    const { createServer } = await import("../../src/server.js");
    const { UpdateTracker } = await import("../../src/updates.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createServer(planka, new UpdateTracker(planka, "/nonexistent/state.json"), { managers });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return async (name: string, args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name, arguments: args });
      return { isError: !!r.isError, text: r.content[0].text, data: r.isError ? undefined : JSON.parse(r.content[0].text) };
    };
  }

  const createRoutes = (extra: Record<string, unknown> = {}) => {
    let n = 0;
    return {
      ...userRoutes,
      "GET /projects": { items: [], included: { boards: [] } },
      "POST /projects": (c: Call) => ({ item: { id: "20", ownerProjectManagerId: "pm1", ...c.body } }),
      "POST /projects/20/boards": (c: Call) => ({ item: { id: "200", ...c.body } }),
      "POST /boards/200/lists": (c: Call) => ({ item: { id: String(300 + ++n), ...c.body } }),
      "POST /boards/200/board-memberships": (c: Call) => ({ item: { id: "bm", ...c.body } }),
      ...extra,
    };
  };

  it("create_project always creates a private project with the default board", async () => {
    const f = fakePlanka(createRoutes());
    const call = await connectWithManagers(f.client, []);
    const r = await call("planka_create_project", { name: "my-repo" });
    expect(r.isError).toBe(false);
    expect(f.calls.find((c) => c.path === "/projects" && c.method === "POST")!.body).toEqual({ type: "private", name: "MY-REPO" });
    expect(r.data.name).toBe("MY-REPO");
    expect(r.data.type).toBe("private");
    expect(r.data.board.lists.map((l: any) => l.name)).toEqual(["Backlog", "In Progress", "Testing", "Done"]);
    expect(f.calls.filter((c) => c.path === "/boards/200/lists").map((c) => c.body.position)).toEqual([65536, 131072, 196608, 262144]);
  });

  it("ignores type: shared (no shared option exists)", async () => {
    const f = fakePlanka(createRoutes());
    const call = await connectWithManagers(f.client, []);
    await call("planka_create_project", { name: "x", type: "shared", hidden: true, board: null });
    expect(f.calls.find((c) => c.path === "/projects" && c.method === "POST")!.body).toEqual({ type: "private", name: "X" });
    expect(f.calls.some((c) => c.method === "PATCH" || c.path.endsWith("/project-managers"))).toBe(false);
  });

  it("adds MANAGERS from the config as board editors, never as project managers", async () => {
    const f = fakePlanka(createRoutes());
    const call = await connectWithManagers(f.client, ["alex@example.com", "carol"]);
    const r = await call("planka_create_project", { name: "repo", lists: [] });
    expect(r.data.boardEditors).toEqual(["alex@example.com", "Carol"]);
    expect(f.calls.filter((c) => c.path === "/boards/200/board-memberships").map((c) => c.body)).toEqual([
      { userId: "2", role: "editor" },
      { userId: "3", role: "editor" },
    ]);
    expect(f.calls.some((c) => c.path.endsWith("/project-managers"))).toBe(false);
  });

  it("an unknown MANAGERS entry creates nothing", async () => {
    const f = fakePlanka(createRoutes());
    const call = await connectWithManagers(f.client, ["nobody"]);
    const r = await call("planka_create_project", { name: "y" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not found");
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("deletes the project again if Planka didn't make it private", async () => {
    const f = fakePlanka(
      createRoutes({
        "POST /projects": (c: Call) => ({ item: { id: "20", ownerProjectManagerId: null, ...c.body } }),
        "DELETE /projects/20": { item: {} },
      }),
    );
    const call = await connectWithManagers(f.client, []);
    const r = await call("planka_create_project", { name: "z" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not create the project as private");
    expect(f.calls.some((c) => c.method === "DELETE" && c.path === "/projects/20")).toBe(true);
    expect(f.calls.some((c) => c.path.includes("/boards"))).toBe(false);
  });

  it("create_project refuses duplicates and supports board: null", async () => {
    const f = fakePlanka({ "GET /projects": projects, "POST /projects": (c: Call) => ({ item: { id: "21", ownerProjectManagerId: "pm", ...c.body } }) });
    const { call } = await connect(f.client);
    const dup = await call("planka_create_project", { name: "Mcp-Planka" });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain("already exists");
    const r = await call("planka_create_project", { name: "bare", board: null });
    expect(r.data.board).toBeUndefined();
    expect(f.calls.some((c) => c.path.includes("/boards"))).toBe(false);
  });

  it("create_board places after existing boards", async () => {
    const f = fakePlanka({
      "GET /projects": projects,
      "POST /projects/10/boards": (c: Call) => ({ item: { id: "101", ...c.body } }),
    });
    const { call } = await connect(f.client);
    const r = await call("planka_create_board", { projectId: "10", name: "Ops", lists: [] });
    expect(f.calls.at(-1)!.body).toEqual({ name: "Ops", position: 131072 });
    expect(r.data).toEqual({ id: "101", name: "Ops", projectId: "10", lists: [] });
  });

  it("create_board with addProjectManagers adds missing managers as editors", async () => {
    let boardCreated = false;
    const f = fakePlanka({
      "GET /projects": () => ({
        items: [{ id: "10", name: "P" }],
        included: {
          users: [{ id: "1", name: "Bot" }, { id: "2", name: "Olga" }],
          projectManagers: [{ projectId: "10", userId: "1" }, { projectId: "10", userId: "2" }],
          boards: boardCreated ? [{ id: "102", projectId: "10", name: "New", position: 65536 }] : [],
        },
      }),
      "POST /projects/10/boards": (c: Call) => {
        boardCreated = true;
        return { item: { id: "102", ...c.body } };
      },
      "GET /boards/102": { item: { id: "102" }, included: { boardMemberships: [{ userId: "1" }] } },
      "POST /boards/102/board-memberships": (c: Call) => ({ item: { id: "900", ...c.body } }),
    });
    const { call } = await connect(f.client);
    const r = await call("planka_create_board", { projectId: "10", name: "New", lists: [], addProjectManagers: true });
    expect(r.isError).toBe(false);
    expect(f.calls.filter((c) => c.path === "/boards/102/board-memberships").map((c) => c.body)).toEqual([
      { userId: "2", role: "editor" },
    ]);
    expect(r.data.addedMembers).toEqual([{ boardId: "102", board: "New", userId: "2", user: "Olga", role: "editor" }]);
  });

  it("create_board adds configured managers as editors by default (opt out possible)", async () => {
    const f = fakePlanka({
      ...userRoutes,
      "GET /projects": projects,
      "POST /projects/10/boards": (c: Call) => ({ item: { id: "104", ...c.body } }),
      "POST /boards/104/board-memberships": (c: Call) => ({ item: { id: "bm", ...c.body } }),
    });
    const { createServer } = await import("../../src/server.js");
    const { UpdateTracker } = await import("../../src/updates.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createServer(f.client, new UpdateTracker(f.client, "/nonexistent/state.json"), { managers: ["alex@example.com"] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r: any = await client.callTool({ name: "planka_create_board", arguments: { projectId: "10", name: "B", lists: [] } });
    expect(JSON.parse(r.content[0].text).editors).toEqual(["alex@example.com"]);
    expect(f.calls.filter((c) => c.path === "/boards/104/board-memberships").map((c) => c.body)).toEqual([
      { userId: "2", role: "editor" },
    ]);
    const n = f.calls.length;
    await client.callTool({ name: "planka_create_board", arguments: { projectId: "10", name: "C", lists: [], addConfiguredManagers: false } });
    expect(f.calls.slice(n).some((c) => c.path.includes("board-memberships") || c.path === "/users")).toBe(false);
  });

  it("create_board without the option adds no members", async () => {
    const f = fakePlanka({ "GET /projects": projects, "POST /projects/10/boards": (c: Call) => ({ item: { id: "103", ...c.body } }) });
    const { call } = await connect(f.client);
    const r = await call("planka_create_board", { projectId: "10", name: "X", lists: [] });
    expect(r.data.addedMembers).toBeUndefined();
    expect(f.calls.some((c) => c.path.includes("board-memberships"))).toBe(false);
  });

  it("update_project: rename, clear description, hide", async () => {
    const f = fakePlanka({
      "GET /projects": projects,
      "PATCH /projects/11": (c: Call) => ({ item: { id: "11", name: "Other", ownerProjectManagerId: "pm", ...c.body } }),
    });
    const { call } = await connect(f.client);
    const r = await call("planka_update_project", { projectId: "11", name: "Renamed", description: null, hidden: true });
    expect(f.calls.at(-1)).toEqual({ method: "PATCH", path: "/projects/11", body: { name: "RENAMED", description: null, isHidden: true } });
    expect(r.data).toEqual({ id: "11", name: "RENAMED", description: null, isHidden: true, type: "private" });
  });

  it("update_project: refuses name clashes and empty updates", async () => {
    const f = fakePlanka({ "GET /projects": projects });
    const { call } = await connect(f.client);
    const clash = await call("planka_update_project", { projectId: "11", name: "mcp-planka" });
    expect(clash.text).toContain("already exists");
    expect((await call("planka_update_project", { projectId: "11" })).text).toContain("Nothing to update");
    expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("update_project: renaming a project to its own name (case change) is allowed", async () => {
    const f = fakePlanka({
      "GET /projects": projects,
      "PATCH /projects/10": (c: Call) => ({ item: { id: "10", ...c.body } }),
    });
    const { call } = await connect(f.client);
    const r = await call("planka_update_project", { projectId: "10", name: "Mcp-Planka" });
    expect(r.isError).toBe(false);
    expect(f.calls.at(-1)!.body).toEqual({ name: "MCP-PLANKA" });
  });
});
