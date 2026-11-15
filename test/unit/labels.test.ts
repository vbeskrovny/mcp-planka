import { describe, expect, it } from "vitest";
import { formatBoard, matchLabels, searchBoard } from "../../src/format.js";
import { connect, fakePlanka } from "../helpers.js";

/** Board: Monitoring (m), Todo (t), an unnamed green label (g); cards with different label sets. */
function board(id = "10", name = "Ops", withTodo = true) {
  const labels = [
    { id: `${id}1`, name: "Monitoring", color: "lagoon-blue", position: 1 },
    ...(withTodo ? [{ id: `${id}2`, name: "todo", color: "berry-red", position: 2 }] : []),
    { id: `${id}3`, name: null, color: "sunny-grass", position: 3 },
  ];
  const cards = [
    { id: `${id}01`, name: "Disk alerts", listId: `${id}a`, position: 1, description: "check disk usage" },
    { id: `${id}02`, name: "Write runbook", listId: `${id}a`, position: 2 },
    { id: `${id}03`, name: "Grafana disk panel", listId: `${id}b`, position: 1 },
    { id: `${id}04`, name: "Unlabelled", listId: `${id}b`, position: 2 },
    { id: `${id}05`, name: "Old disk thing", listId: `${id}z`, position: 1 },
  ];
  const cardLabels = [
    { cardId: `${id}01`, labelId: `${id}1` },
    ...(withTodo ? [{ cardId: `${id}01`, labelId: `${id}2` }, { cardId: `${id}02`, labelId: `${id}2` }] : []),
    { cardId: `${id}03`, labelId: `${id}1` },
    { cardId: `${id}03`, labelId: `${id}3` },
    { cardId: `${id}05`, labelId: `${id}1` },
  ];
  return {
    item: { id, name, projectId: "1" },
    included: {
      labels,
      cards,
      cardLabels,
      lists: [
        { id: `${id}a`, name: "Backlog", type: "active", position: 1 },
        { id: `${id}b`, name: "Doing", type: "active", position: 2 },
        { id: `${id}c`, name: "Empty", type: "active", position: 3 },
        { id: `${id}z`, name: null, type: "archive", position: 9 },
      ],
    },
  };
}
const b = board();
const names = (resp: any, ids: Set<string>) => resp.included.cards.filter((c: any) => ids.has(c.id)).map((c: any) => c.name);

describe("matchLabels", () => {
  it("any = OR, all = AND, case-insensitive", () => {
    expect(names(b, matchLabels(b, { labels: ["monitoring", "TODO"] }).cardIds)).toEqual([
      "Disk alerts", "Write runbook", "Grafana disk panel", "Old disk thing",
    ]);
    expect(names(b, matchLabels(b, { labels: ["Monitoring", "todo"], match: "all" }).cardIds)).toEqual(["Disk alerts"]);
    expect(names(b, matchLabels(b, { labels: ["todo"] }).cardIds)).toEqual(["Disk alerts", "Write runbook"]);
  });

  it("matches unnamed labels by color", () => {
    expect(names(b, matchLabels(b, { labels: ["Sunny-Grass"] }).cardIds)).toEqual(["Grafana disk panel"]);
  });

  it("reports labels the board doesn't have; with all, nothing can match", () => {
    expect(matchLabels(b, { labels: ["monitoring", "bugg"] }).missing).toEqual(["bugg"]);
    expect(names(b, matchLabels(b, { labels: ["monitoring", "bugg"] }).cardIds)).toHaveLength(3);
    expect(matchLabels(b, { labels: ["monitoring", "bugg"], match: "all" }).cardIds.size).toBe(0);
  });

  it("ignores duplicates and blank names", () => {
    const r = matchLabels(b, { labels: ["todo", "TODO", " "], match: "all" });
    expect(names(b, r.cardIds)).toEqual(["Disk alerts", "Write runbook"]);
    expect(r.missing).toEqual([]);
  });
});

describe("searchBoard with labels", () => {
  it("labels only: every matching card, with its labels, archive skipped", () => {
    const hits = searchBoard(b, undefined, { labelFilter: { labels: ["monitoring"] } });
    expect(hits.map((h) => [h.name, h.matchedIn, h.labels])).toEqual([
      ["Disk alerts", "labels", ["Monitoring", "todo"]],
      ["Grafana disk panel", "labels", ["Monitoring", "sunny-grass"]],
    ]);
    expect(searchBoard(b, undefined, { labelFilter: { labels: ["monitoring"] }, includeArchived: true })).toHaveLength(3);
  });

  it("labels + text: both must match", () => {
    const hits = searchBoard(b, "disk", { labelFilter: { labels: ["todo"] } });
    expect(hits.map((h) => [h.name, h.matchedIn])).toEqual([["Disk alerts", "name"]]);
  });

  it("text only still works and now includes labels", () => {
    const hits = searchBoard(b, "usage");
    expect(hits.map((h) => [h.name, h.matchedIn, h.labels])).toEqual([["Disk alerts", "description", ["Monitoring", "todo"]]]);
    expect(searchBoard(b, "unlabelled")[0].labels).toBeUndefined();
  });
});

describe("formatBoard with labels", () => {
  it("keeps only matching cards and drops lists without them", () => {
    const out: any = formatBoard(b, { labelFilter: { labels: ["monitoring", "todo"], match: "all" } });
    expect(out.lists.map((l: any) => [l.name, l.cards.map((c: any) => c.name)])).toEqual([["Backlog", ["Disk alerts"]]]);
    expect(out.labelFilter).toEqual({ labels: ["monitoring", "todo"], match: "all", matchingCards: 1 });
    expect(out.labels).toHaveLength(3);
  });

  it("reports missing labels, and is unchanged without a filter", () => {
    const out: any = formatBoard(b, { labelFilter: { labels: ["nope"] } });
    expect(out.lists ?? []).toEqual([]);
    expect(out.labelFilter).toMatchObject({ matchingCards: 0, missingLabels: ["nope"] });
    const plain: any = formatBoard(b);
    expect(plain.labelFilter).toBeUndefined();
    expect(plain.lists.map((l: any) => l.name)).toEqual(["Backlog", "Doing", "Empty"]);
  });
});

describe("planka_search_cards / planka_get_board with labels", () => {
  // 1: own private project; 2: shared project; 3: someone else's private project (bot is a board member there)
  const projects = {
    items: [
      { id: "1", name: "OPS", ownerProjectManagerId: "pm1" },
      { id: "2", name: "Shared", ownerProjectManagerId: null },
      { id: "3", name: "Foreign", ownerProjectManagerId: "pm3" },
    ],
    included: {
      projectManagers: [{ id: "pm1", projectId: "1", userId: "BOT" }, { id: "pm3", projectId: "3", userId: "OTHER" }],
      boards: [
        { id: "10", projectId: "1" }, { id: "20", projectId: "1" }, { id: "30", projectId: "1" },
        { id: "40", projectId: "2" }, { id: "50", projectId: "3" },
      ],
    },
  };
  const routes = {
    "GET /users/me": { item: { id: "BOT" } },
    "GET /projects": projects,
    "GET /boards/40": board("40", "SharedBoard"),
    "GET /boards/50": board("50", "ForeignBoard"),
    "GET /boards/10": board("10", "Ops"),
    "GET /boards/20": board("20", "Infra", false),
    // 30: no route → 404, like a board the bot can't read
  };

  it("finds monitoring OR todo across a project, reporting missing labels and unreadable boards", async () => {
    const { call } = await connect(fakePlanka(routes).client);
    const r = await call("planka_search_cards", { projectId: "1", labels: ["monitoring", "todo"] });
    expect(r.isError).toBe(false);
    expect(r.data.match).toBe("any");
    expect(r.data.boardsSearched).toBe(2);
    expect(r.data.results.map((h: any) => `${h.board}/${h.name}`)).toEqual([
      "Ops/Disk alerts", "Ops/Write runbook", "Ops/Grafana disk panel", "Infra/Disk alerts", "Infra/Grafana disk panel",
    ]);
    expect(r.data.missingLabels).toEqual([{ boardId: "20", board: "Infra", labels: ["todo"] }]);
    expect(r.data.labelsNotFound).toBeUndefined();
    expect(r.data.skippedBoards).toEqual([{ boardId: "30", error: expect.stringContaining("404") }]);
  });

  it("monitoring AND todo; with text; limit", async () => {
    const { call } = await connect(fakePlanka(routes).client);
    const all = await call("planka_search_cards", { projectId: "1", labels: ["Monitoring", "Todo"], match: "all" });
    expect(all.data.results.map((h: any) => `${h.board}/${h.name}`)).toEqual(["Ops/Disk alerts"]);
    const text = await call("planka_search_cards", { boardId: "10", query: "grafana", labels: ["monitoring"] });
    expect(text.data.results.map((h: any) => h.name)).toEqual(["Grafana disk panel"]);
    const lim = await call("planka_search_cards", { projectId: "1", labels: ["monitoring"], limit: 1 });
    expect(lim.data).toMatchObject({ total: 1, truncated: true });
  });

  it("never reads shared projects or other people's private projects", async () => {
    const f = fakePlanka(routes);
    const { call } = await connect(f.client);
    const r = await call("planka_search_cards", { labels: ["monitoring"] });
    expect(r.data.excludedProjects).toBe(2);
    expect(r.data.missingLabels).toBeUndefined(); // account-wide: no per-board noise
    expect(r.data.results.map((h: any) => h.board)).not.toContain("SharedBoard");
    expect(r.data.results.map((h: any) => h.board)).not.toContain("ForeignBoard");
    expect(f.calls.map((c) => c.path)).not.toContain("/boards/40");
    expect(f.calls.map((c) => c.path)).not.toContain("/boards/50");

    for (const args of [{ projectId: "2" }, { projectId: "3" }, { projectId: "999" }]) {
      const x = await call("planka_search_cards", { ...args, labels: ["monitoring"] });
      expect(x.text, JSON.stringify(args)).toMatch(/not one of your own private projects/);
    }
    for (const bid of ["40", "50", "999"]) {
      const x = await call("planka_search_cards", { boardId: bid, query: "disk" });
      expect(x.text, bid).toMatch(/not in one of your own private projects/);
    }
    expect(f.calls.filter((c) => /^\/boards\/(40|50)$/.test(c.path))).toEqual([]);
  });

  it("labelsNotFound names labels that exist on no searched board", async () => {
    const { call } = await connect(fakePlanka(routes).client);
    const r = await call("planka_search_cards", { labels: ["todo", "bugg", "Bugg"] });
    expect(r.data.labelsNotFound).toEqual(["bugg"]);
    expect(r.data.results.length).toBeGreaterThan(0);
  });

  it("needs query or labels; a single unreadable board is an error", async () => {
    const { call } = await connect(fakePlanka(routes).client);
    expect((await call("planka_search_cards", {})).text).toMatch(/query, labels or both/);
    expect((await call("planka_search_cards", { boardId: "30", labels: ["x"] })).isError).toBe(true);
  });

  it("get_board filters by labels", async () => {
    const { call } = await connect(fakePlanka(routes).client);
    const r = await call("planka_get_board", { boardId: "10", labels: ["todo"] });
    expect(r.data.lists.map((l: any) => [l.name, l.cards.map((c: any) => c.name)])).toEqual([
      ["Backlog", ["Disk alerts", "Write runbook"]],
    ]);
    expect(r.data.labelFilter).toEqual({ labels: ["todo"], match: "any", matchingCards: 2 });
  });
});
