import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatBoard, formatCard, formatProjects, searchBoard, truncate } from "../../src/format.js";

const board = JSON.parse(readFileSync(new URL("../fixtures/board.json", import.meta.url), "utf8"));

describe("formatProjects", () => {
  it("nests boards under their project sorted by position", () => {
    const out = formatProjects({
      items: [{ id: "1", name: "P", description: null }],
      included: {
        boards: [
          { id: "b2", projectId: "1", name: "B2", position: 2 },
          { id: "b1", projectId: "1", name: "B1", position: 1 },
          { id: "bx", projectId: "other", name: "X", position: 0 },
        ],
      },
    });
    expect(out).toEqual([{ id: "1", name: "P", boards: [{ id: "b1", name: "B1" }, { id: "b2", name: "B2" }] }]);
  });
});

describe("formatBoard", () => {
  const out = formatBoard(board) as any;

  it("orders lists by position and hides archive/trash by default", () => {
    expect(out.lists.map((l: any) => l.name)).toEqual(["Todo", "Doing", "Done"]);
    expect(out.lists[2].type).toBe("closed");
    expect(out.lists[0].type).toBeUndefined();
  });

  it("includes archive lists on request", () => {
    expect((formatBoard(board, { includeArchived: true }) as any).lists).toHaveLength(4);
  });

  it("orders cards, resolves label names (falls back to color) and task progress", () => {
    const [first, second] = out.lists[0].cards;
    expect(first).toEqual({
      id: "4000000000000000001",
      name: "First card",
      labels: ["bug", "lagoon-blue"],
      tasks: "1/3",
      due: "2026-12-01T12:00:00.000Z",
      comments: 3,
    });
    expect(second).toEqual({ id: "4000000000000000002", name: "Second" });
  });

  it("keeps IDs as strings and includes project + labels", () => {
    expect(typeof out.id).toBe("string");
    expect(out.project).toEqual({ id: "1000000000000000000", name: "Demo Project" });
    expect(out.labels[0]).toEqual({ id: "3000000000000000001", name: "bug", color: "berry-red" });
  });

  it("omits empty lists' cards arrays and description unless asked", () => {
    expect(out.lists[1].cards).toBeUndefined();
    const withDesc = formatBoard(board, { includeDescriptions: true }) as any;
    expect(withDesc.lists[0].cards[1].description).toBe("Fix the login timeout bug on mobile");
  });

  it("is much smaller than the raw payload", () => {
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(board).length / 2);
  });
});

describe("formatCard", () => {
  const cardResp = {
    item: board.included.cards[1],
    included: {
      cardLabels: board.included.cardLabels,
      taskLists: board.included.taskLists,
      tasks: [...board.included.tasks].reverse(),
      users: [],
    },
  };
  const comments = {
    items: [
      { id: "c2", userId: "9000000000000000001", text: "later", createdAt: "2026-01-03T00:00:00Z" },
      { id: "c1", userId: "9000000000000000001", text: "earlier", createdAt: "2026-01-02T00:00:00Z" },
    ],
    included: { users: board.included.users },
  };

  it("builds a full card view with list, labels, tasks and ordered comments", () => {
    const out = formatCard(cardResp, comments, board) as any;
    expect(out.board).toEqual({ id: "1000000000000000001", name: "Demo Board" });
    expect(out.list).toEqual({ id: "2000000000000000001", name: "Todo", type: "active" });
    expect(out.labels).toEqual([
      { id: "3000000000000000001", name: "bug", color: "berry-red" },
      { id: "3000000000000000002", color: "lagoon-blue" },
    ]);
    expect(out.taskLists[0].tasks.map((t: any) => [t.name, t.done])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
    expect(out.comments.map((c: any) => c.text)).toEqual(["earlier", "later"]);
    expect(out.comments[0].author).toBe("Alex Example");
  });

  it("works without board/comments context", () => {
    const out = formatCard(cardResp) as any;
    expect(out.list).toEqual({ id: "2000000000000000001" });
    expect(out.comments).toBeUndefined();
  });
});

describe("searchBoard", () => {
  it("matches name and description case-insensitively, skipping archived lists", () => {
    const hits = searchBoard(board, "login");
    expect(hits.map((h) => [h.name, h.matchedIn])).toEqual([
      ["Second", "description"],
      ["Shipped LOGIN", "name"],
    ]);
    expect(hits[0].list).toBe("Todo");
    expect(hits[0].snippet).toContain("login timeout");
  });
  it("includes archived on request", () => {
    expect(searchBoard(board, "login", { includeArchived: true })).toHaveLength(3);
  });
});

describe("truncate", () => {
  it("flattens whitespace and adds ellipsis", () => {
    expect(truncate("a\n\n b  c", 100)).toBe("a b c");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate(null, 4)).toBeUndefined();
  });
});
