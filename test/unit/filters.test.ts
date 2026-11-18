import { describe, expect, it } from "vitest";
import { cardFilterFrom, cardPasses, hasDueFilter, parseDueBound, selectLists } from "../../src/filters.js";
import { formatBoard, searchBoard } from "../../src/format.js";
import { connect, fakePlanka } from "../helpers.js";

/** Planner-style board: Reminders, Waiting, Done (closed), Cancelled (closed), Archive. */
function board(id = "10", name = "Planner") {
  const card = (n: number, cardName: string, list: string, extra: Record<string, unknown> = {}) => ({
    id: `${id}0${n}`,
    name: cardName,
    listId: `${id}${list}`,
    position: n,
    ...extra,
  });
  return {
    item: { id, name, projectId: "1" },
    included: {
      labels: [{ id: `${id}L`, name: "reminder", color: "berry-red", position: 1 }],
      cardLabels: [{ cardId: `${id}01`, labelId: `${id}L` }],
      lists: [
        { id: `${id}r`, name: "Reminders", type: "active", position: 1 },
        { id: `${id}w`, name: "Waiting", type: "active", position: 2 },
        { id: `${id}d`, name: "Done", type: "closed", position: 3 },
        { id: `${id}c`, name: "Cancelled", type: "closed", position: 4 },
        { id: `${id}z`, name: "Old", type: "archive", position: 9 },
      ],
      cards: [
        card(1, "Pay rent", "r", { dueDate: "2026-11-25T08:00:00.000Z", description: "Transfer\n\nto landlord, ref 42" }),
        card(2, "Dentist", "r", { dueDate: "2026-11-20T23:30:00.000Z" }),
        card(3, "Overdue call", "w", { dueDate: "2026-11-10T09:00:00.000Z" }),
        card(4, "Done but due", "w", { dueDate: "2026-11-12T09:00:00.000Z", isDueCompleted: true }),
        card(5, "No due", "w"),
        card(6, "Closed in active list", "w", { isClosed: true, dueDate: "2026-11-21T09:00:00.000Z" }),
        card(7, "Shipped", "d", { isClosed: true, dueDate: "2026-11-22T09:00:00.000Z" }),
        card(8, "Dropped", "c", { isClosed: true }),
        card(9, "Archived", "z", { dueDate: "2026-11-21T09:00:00.000Z" }),
      ],
    },
  };
}
const b = board();

describe("parseDueBound", () => {
  it("expands a plain date to the whole UTC day", () => {
    expect(new Date(parseDueBound("2026-11-20", "from")).toISOString()).toBe("2026-11-20T00:00:00.000Z");
    expect(new Date(parseDueBound("2026-11-20", "to")).toISOString()).toBe("2026-11-20T23:59:59.999Z");
  });
  it("takes a date-time as is, and rejects garbage", () => {
    expect(parseDueBound("2026-11-20T09:00:00+01:00", "to")).toBe(Date.parse("2026-11-20T08:00:00Z"));
    expect(() => parseDueBound("next week", "from")).toThrow(/Invalid date "next week"/);
  });
});

describe("cardFilterFrom", () => {
  it("is undefined without any filter", () => {
    expect(cardFilterFrom({})).toBeUndefined();
  });
  it("keeps closed: false and dueCompleted: false", () => {
    expect(cardFilterFrom({ closed: false })).toEqual({ closed: false });
    expect(hasDueFilter(cardFilterFrom({ dueCompleted: false }))).toBe(true);
    expect(hasDueFilter(cardFilterFrom({ closed: true }))).toBe(false);
  });
  it("rejects dueFrom after dueTo", () => {
    expect(() => cardFilterFrom({ dueFrom: "2026-11-21", dueTo: "2026-11-20" })).toThrow(/dueFrom is after dueTo/);
    expect(cardFilterFrom({ dueFrom: "2026-11-20", dueTo: "2026-11-20" })).toBeDefined();
  });
});

describe("cardPasses", () => {
  const active = { type: "active" };
  const closedList = { type: "closed" };
  it("treats cards in closed lists as closed", () => {
    expect(cardPasses({}, closedList, { closed: false })).toBe(false);
    expect(cardPasses({}, closedList, { closed: true })).toBe(true);
    expect(cardPasses({ isClosed: true }, active, { closed: true })).toBe(true);
    expect(cardPasses({}, active, { closed: false })).toBe(true);
  });
  it("leaves out cards without a due date once any due filter is set", () => {
    expect(cardPasses({}, active, { dueCompleted: false })).toBe(false);
    expect(cardPasses({ dueDate: "2026-11-20T00:00:00Z" }, active, { dueCompleted: false })).toBe(true);
    expect(cardPasses({ dueDate: "2026-11-20T00:00:00Z", isDueCompleted: true }, active, { dueCompleted: false })).toBe(false);
  });
  it("uses inclusive bounds", () => {
    const t = Date.parse("2026-11-20T00:00:00Z");
    expect(cardPasses({ dueDate: "2026-11-20T00:00:00Z" }, active, { dueFrom: t, dueTo: t })).toBe(true);
    expect(cardPasses({ dueDate: "2026-11-20T00:00:00.001Z" }, active, { dueTo: t })).toBe(false);
  });
});

describe("selectLists", () => {
  it("matches names case-insensitively and IDs exactly, reporting the rest", () => {
    const r = selectLists(b.included.lists, ["reminders", "10w", "Nope", "Nope"]);
    expect([...r.ids]).toEqual(["10r", "10w"]);
    expect(r.missing).toEqual(["Nope"]);
  });
});

describe("formatBoard with lists / closed / full descriptions", () => {
  const cardNames = (out: any) => out.lists.map((l: any) => [l.name, (l.cards ?? []).map((c: any) => c.name)]);

  it("lists: only the named lists, in board order, including a named archive list", () => {
    const out = formatBoard(b, { lists: ["old", "Reminders", "missing"] }) as any;
    expect(out.lists.map((l: any) => l.name)).toEqual(["Reminders", "Old"]);
    expect(out.listFilter).toEqual({ lists: ["old", "Reminders", "missing"], missingLists: ["missing"] });
    expect((formatBoard(b) as any).listFilter).toBeUndefined();
  });

  it("closed: false drops closed lists and closed cards but keeps empty open lists", () => {
    const empty = { ...b, included: { ...b.included, cards: [] } };
    expect((formatBoard(empty, { cardFilter: { closed: false } }) as any).lists.map((l: any) => l.name)).toEqual([
      "Reminders",
      "Waiting",
    ]);
    expect(cardNames(formatBoard(b, { cardFilter: { closed: false } }))).toEqual([
      ["Reminders", ["Pay rent", "Dentist"]],
      ["Waiting", ["Overdue call", "Done but due", "No due"]],
    ]);
  });

  it("closed: true keeps only lists with closed cards", () => {
    expect(cardNames(formatBoard(b, { cardFilter: { closed: true } }))).toEqual([
      ["Waiting", ["Closed in active list"]],
      ["Done", ["Shipped"]],
      ["Cancelled", ["Dropped"]],
    ]);
  });

  it('includeDescriptions: "full" returns the complete text, true a flattened preview', () => {
    const full = formatBoard(b, { includeDescriptions: "full" }) as any;
    expect(full.lists[0].cards[0].description).toBe("Transfer\n\nto landlord, ref 42");
    const short = formatBoard(b, { includeDescriptions: true }) as any;
    expect(short.lists[0].cards[0].description).toBe("Transfer to landlord, ref 42");
  });
});

describe("searchBoard with card filters", () => {
  it("without a query, returns every card passing the filters, with due and closed info", () => {
    const hits = searchBoard(b, undefined, {
      cardFilter: cardFilterFrom({ dueFrom: "2026-11-20", dueTo: "2026-11-27" }),
    });
    expect(hits.map((h) => [h.name, h.matchedIn, h.due, h.closed])).toEqual([
      ["Pay rent", "filter", "2026-11-25T08:00:00.000Z", undefined],
      ["Dentist", "filter", "2026-11-20T23:30:00.000Z", undefined],
      ["Closed in active list", "filter", "2026-11-21T09:00:00.000Z", true],
      ["Shipped", "filter", "2026-11-22T09:00:00.000Z", true],
    ]);
  });

  it("overdue and not completed", () => {
    const hits = searchBoard(b, undefined, {
      cardFilter: cardFilterFrom({ dueTo: "2026-11-18T12:00:00Z", dueCompleted: false, closed: false }),
    });
    expect(hits.map((h) => h.name)).toEqual(["Overdue call"]);
    const done = searchBoard(b, undefined, { cardFilter: { dueCompleted: true } });
    expect(done.map((h) => [h.name, h.dueDone])).toEqual([["Done but due", true]]);
  });

  it("combines with a query and labels; full descriptions on request", () => {
    const hits = searchBoard(b, "rent", {
      labelFilter: { labels: ["reminder"] },
      cardFilter: { closed: false },
      includeDescriptions: "full",
    });
    expect(hits).toEqual([
      expect.objectContaining({ name: "Pay rent", matchedIn: "name", description: "Transfer\n\nto landlord, ref 42" }),
    ]);
    expect(searchBoard(b, undefined, { labelFilter: { labels: ["reminder"] } })[0].matchedIn).toBe("labels");
  });
});

describe("planka_search_cards / planka_get_board with filters (tools)", () => {
  const routes = {
    "GET /users/me": { item: { id: "BOT" } },
    "GET /projects": {
      items: [{ id: "1", name: "PLANNER", ownerProjectManagerId: "pm1" }],
      included: {
        projectManagers: [{ id: "pm1", projectId: "1", userId: "BOT" }],
        boards: [{ id: "10", projectId: "1" }, { id: "20", projectId: "1" }],
      },
    },
    "GET /boards/10": board("10", "Planner"),
    "GET /boards/20": board("20", "Family"),
  };

  it("lists due cards across boards sorted by due date, even with a small limit", async () => {
    const { call } = await connect(fakePlanka(routes).client);
    const r = await call("planka_search_cards", {
      projectId: "1",
      dueFrom: "2026-11-20",
      dueTo: "2026-11-27",
      closed: false,
      limit: 3,
    });
    expect(r.isError).toBe(false);
    expect(r.data.boardsSearched).toBe(2);
    expect(r.data.results.map((h: any) => `${h.board}/${h.name}`)).toEqual([
      "Planner/Dentist",
      "Family/Dentist",
      "Planner/Pay rent",
    ]);
    expect(r.data).toMatchObject({ total: 3, truncated: true });
  });

  it("accepts closed alone, and rejects bad dates and reversed ranges", async () => {
    const { call } = await connect(fakePlanka(routes).client);
    const closed = await call("planka_search_cards", { boardId: "10", closed: true });
    expect(closed.data.results.map((h: any) => h.name)).toEqual(["Closed in active list", "Shipped", "Dropped"]);
    expect((await call("planka_search_cards", { dueFrom: "soon" })).text).toMatch(/Invalid date "soon"/);
    expect((await call("planka_search_cards", { dueFrom: "2026-12-01", dueTo: "2026-11-01" })).text).toMatch(
      /dueFrom is after dueTo/,
    );
    expect((await call("planka_search_cards", { includeDescriptions: "full" })).isError).toBe(true);
  });

  it("get_board: lists + closed: false + full descriptions", async () => {
    const { call } = await connect(fakePlanka(routes).client);
    const r = await call("planka_get_board", {
      boardId: "10",
      lists: ["reminders", "Done"],
      closed: false,
      includeDescriptions: "full",
    });
    expect(r.data.lists.map((l: any) => l.name)).toEqual(["Reminders"]);
    expect(r.data.lists[0].cards[0].description).toBe("Transfer\n\nto landlord, ref 42");
    expect((await call("planka_get_board", { boardId: "10", includeDescriptions: "short" })).isError).toBe(true);
  });
});
