import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { UpdateTracker } from "../../src/updates.js";
import { fakePlanka } from "../helpers.js";

const ME = "1";
const HUMAN = "2";
const BOARD = "100";
const BACKLOG = "200";
const DOING = "201";
const DONE = "202";

describe("UpdateTracker", () => {
  let statePath: string;
  let clock: number;
  const now = () => new Date(clock);
  beforeEach(() => {
    statePath = join(mkdtempSync(join(tmpdir(), "planka-state-")), "state.json");
    clock = Date.parse("2026-11-12T10:00:00Z");
  });

  const setup = () => {
    const w = {
      cards: [] as any[],
      comments: {} as Record<string, any[]>,
      tasks: [] as any[], // { id, cardId, name, isCompleted, createdAt }
      actions: {} as Record<string, any[]>, // cardId -> action log; missing = log can't be read (404)
      labels: [{ id: "L1", name: "Start", color: "berry-red" }, { id: "L2", name: "bug", color: "pink-tulip" }] as any[],
      cardLabels: [] as any[], // { cardId, labelId, createdAt? }
    };
    const routes: Record<string, any> = {
      "GET /users/me": { item: { id: ME } },
      "GET /projects": { items: [{ id: "10" }], included: { boards: [{ id: BOARD, projectId: "10" }] } },
      [`GET /boards/${BOARD}`]: () => ({
        item: { id: BOARD, name: "Dev" },
        included: {
          lists: [
            { id: BACKLOG, name: "Backlog", type: "active" },
            { id: DOING, name: "Doing", type: "active" },
            { id: DONE, name: "Done", type: "active" },
          ],
          users: [
            { id: ME, name: "Bot" },
            { id: HUMAN, name: "Olga" },
          ],
          cards: w.cards.map((c) => ({ ...c, commentsTotal: (w.comments[c.id] ?? []).length })),
          taskLists: w.cards.map((c) => ({ id: `tl-${c.id}`, cardId: c.id, name: "TODO" })),
          tasks: w.tasks.map(({ cardId, ...t }) => ({ ...t, taskListId: `tl-${cardId}` })),
          labels: w.labels,
          cardLabels: w.cardLabels,
        },
      }),
    };
    const f = fakePlanka(
      new Proxy(routes, {
        get(t, k: string) {
          const m = /^GET \/cards\/(\w+)\/comments$/.exec(k);
          if (m) return { items: w.comments[m[1]] ?? [], included: { users: [{ id: HUMAN, name: "Olga" }] } };
          const a = /^GET \/cards\/(\w+)\/actions$/.exec(k);
          if (a) return w.actions[a[1]] && { items: w.actions[a[1]], included: { users: [{ id: HUMAN, name: "Olga" }, { id: ME, name: "Bot" }] } };
          return t[k];
        },
      }),
    );
    const tracker = new UpdateTracker(f.client, statePath, { now });
    const tick = (min: number) => {
      clock += min * 60_000;
      return new Date(clock).toISOString();
    };
    return { w, f, tracker, tick };
  };

  it("first check records a baseline without events", async () => {
    const { w, tracker } = setup();
    w.cards.push({ id: "c1", listId: BACKLOG, name: "old", creatorUserId: HUMAN, createdAt: "2020-01-01T00:00:00Z" });
    w.comments.c1 = [{ id: "m1", userId: HUMAN, text: "old", createdAt: "2020-01-01T00:00:00Z" }];
    const r = await tracker.check();
    expect(r.events).toEqual([]);
    expect(r.boards).toEqual([{ id: BOARD, name: "Dev", initialized: true }]);
  });

  it("reports new backlog cards by humans, not by the bot, and not in other lists", async () => {
    const { w, tracker, tick } = setup();
    await tracker.check();
    const at = tick(1);
    w.cards.push({ id: "c1", listId: BACKLOG, name: "Human idea", creatorUserId: HUMAN, createdAt: at });
    w.cards.push({ id: "c2", listId: BACKLOG, name: "Bot card", creatorUserId: ME, createdAt: at });
    w.cards.push({ id: "c3", listId: DOING, name: "Elsewhere", creatorUserId: HUMAN, createdAt: at });
    tick(1);
    const r = await tracker.check();
    expect(r.events).toEqual([
      expect.objectContaining({ type: "backlog_card", cardId: "c1", name: "Human idea", movedIn: false, by: "Olga", list: "Backlog" }),
    ]);
    expect((await tracker.check()).events).toEqual([]); // consumed
  });

  it("reports cards moved into the backlog", async () => {
    const { w, tracker, tick } = setup();
    w.cards.push({ id: "c3", listId: DOING, name: "Bounce", creatorUserId: ME, createdAt: "2020-01-01T00:00:00Z" });
    await tracker.check();
    w.cards[0] = { ...w.cards[0], listId: BACKLOG, listChangedAt: tick(1) };
    const r = await tracker.check();
    expect(r.events).toEqual([expect.objectContaining({ type: "backlog_card", cardId: "c3", movedIn: true })]);
  });

  it("reports new human comments only, once", async () => {
    const { w, tracker, tick } = setup();
    w.cards.push({ id: "c1", listId: DOING, name: "Task", creatorUserId: ME, createdAt: "2020-01-01T00:00:00Z" });
    w.comments.c1 = [{ id: "m0", userId: HUMAN, text: "before", createdAt: "2020-01-01T00:00:00Z" }];
    await tracker.check();
    w.comments.c1.push({ id: "m1", userId: HUMAN, text: "Can you take this?", createdAt: tick(1) });
    w.comments.c1.push({ id: "m2", userId: ME, text: "bot reply", createdAt: tick(1) });
    const r = await tracker.check();
    expect(r.events).toEqual([
      expect.objectContaining({ type: "comment", cardId: "c1", card: "Task", commentId: "m1", author: "Olga", text: "Can you take this?" }),
    ]);
    expect((await tracker.check()).events).toEqual([]);
  });

  it("peek does not consume events", async () => {
    const { w, tracker, tick } = setup();
    await tracker.check();
    w.cards.push({ id: "c1", listId: BACKLOG, name: "X", creatorUserId: HUMAN, createdAt: tick(1) });
    expect((await tracker.check({ peek: true })).events).toHaveLength(1);
    expect((await tracker.check()).events).toHaveLength(1);
    expect((await tracker.check()).events).toHaveLength(0);
  });

  it("state persists across tracker instances", async () => {
    const { w, f, tracker, tick } = setup();
    await tracker.check();
    w.cards.push({ id: "c1", listId: BACKLOG, name: "X", creatorUserId: HUMAN, createdAt: tick(1) });
    const fresh = new UpdateTracker(f.client, statePath, { now });
    expect((await fresh.check()).events).toHaveLength(1);
  });

  it("is exposed as planka_check_updates", async () => {
    const { w, f, tick } = setup();
    const { createServer } = await import("../../src/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const server = createServer(f.client, new UpdateTracker(f.client, statePath, { now }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.callTool({ name: "planka_check_updates", arguments: {} });
    w.cards.push({ id: "c1", listId: BACKLOG, name: "X", creatorUserId: HUMAN, createdAt: tick(1) });
    const r: any = await client.callTool({ name: "planka_check_updates", arguments: { projectId: "10" } });
    expect(JSON.parse(r.content[0].text).events[0].cardId).toBe("c1");
  });

  const move = (userId: string, from: string, to: string, at: string) => ({
    type: "moveCard", userId, createdAt: at, data: { fromList: { id: from, name: from === DOING ? "Doing" : from === BACKLOG ? "Backlog" : "Done" }, toList: { id: to } },
  });

  it("reports cards moved between other lists, with from/to and who moved them", async () => {
    const { w, tracker, tick } = setup();
    w.cards.push({ id: "c1", listId: DOING, name: "Ship it", creatorUserId: ME, createdAt: "2020-01-01T00:00:00Z" });
    await tracker.check();
    const at = tick(1);
    w.cards[0] = { ...w.cards[0], listId: DONE, listChangedAt: at };
    w.actions.c1 = [move(HUMAN, BACKLOG, DOING, "2020-01-01T00:00:00Z"), move(HUMAN, DOING, DONE, at)];
    const r = await tracker.check();
    expect(r.events).toEqual([
      { type: "card_moved", boardId: BOARD, board: "Dev", cardId: "c1", name: "Ship it", fromListId: DOING, fromList: "Doing", listId: DONE, list: "Done", by: "Olga", at },
    ]);
    expect((await tracker.check()).events).toEqual([]); // consumed
  });

  it("skips the bot's own moves, into any list", async () => {
    const { w, tracker, tick } = setup();
    w.cards.push({ id: "c1", listId: DOING, name: "A", creatorUserId: ME, createdAt: "2020-01-01T00:00:00Z" });
    w.cards.push({ id: "c2", listId: DOING, name: "B", creatorUserId: ME, createdAt: "2020-01-01T00:00:00Z" });
    await tracker.check();
    const at = tick(1);
    w.cards[0] = { ...w.cards[0], listId: DONE, listChangedAt: at };
    w.cards[1] = { ...w.cards[1], listId: BACKLOG, listChangedAt: at };
    w.actions.c1 = [move(ME, DOING, DONE, at)];
    w.actions.c2 = [move(ME, DOING, BACKLOG, at)];
    expect((await tracker.check()).events).toEqual([]);
  });

  it("moves into the backlog by a person carry fromList and by; an unreadable log still reports the move", async () => {
    const { w, tracker, tick } = setup();
    w.cards.push({ id: "c1", listId: DONE, name: "Reopen", creatorUserId: ME, createdAt: "2020-01-01T00:00:00Z" });
    w.cards.push({ id: "c2", listId: DOING, name: "No log", creatorUserId: ME, createdAt: "2020-01-01T00:00:00Z" });
    await tracker.check();
    const at = tick(1);
    w.cards[0] = { ...w.cards[0], listId: BACKLOG, listChangedAt: at };
    w.cards[1] = { ...w.cards[1], listId: DONE, listChangedAt: at };
    w.actions.c1 = [move(HUMAN, DONE, BACKLOG, at)];
    const r = await tracker.check();
    expect(r.events).toEqual([
      expect.objectContaining({ type: "backlog_card", cardId: "c1", movedIn: true, fromList: "Done", by: "Olga" }),
      expect.objectContaining({ type: "card_moved", cardId: "c2", fromList: "Doing", list: "Done", by: undefined }),
    ]);
  });

  describe("tasks", () => {
    const card = { id: "c1", listId: DOING, name: "Checklist", creatorUserId: ME, createdAt: "2020-01-01T00:00:00Z" };
    const task = (id: string, name: string, isCompleted = false, createdAt = "2020-01-01T00:00:00Z") =>
      ({ id, cardId: "c1", name, isCompleted, createdAt });
    const act = (type: string, userId: string, taskId: string, at: string) =>
      ({ type, userId, createdAt: at, data: { task: { id: taskId } } });

    it("reports ticked and unticked tasks by a person, not by the bot", async () => {
      const { w, tracker, tick } = setup();
      w.cards.push({ ...card });
      w.tasks.push(task("t1", "Write docs"), task("t2", "Deploy", true), task("t3", "Bot job"));
      await tracker.check();
      const at = tick(1);
      w.tasks[0].isCompleted = true;
      w.tasks[1].isCompleted = false;
      w.tasks[2].isCompleted = true;
      w.actions.c1 = [act("completeTask", HUMAN, "t1", at), act("uncompleteTask", HUMAN, "t2", at), act("completeTask", ME, "t3", at)];
      const r = await tracker.check();
      expect(r.events).toEqual([
        { type: "task", boardId: BOARD, board: "Dev", list: "Doing", cardId: "c1", card: "Checklist", taskId: "t1", task: "Write docs", taskList: "TODO", completed: true, by: "Olga", at },
        expect.objectContaining({ type: "task", taskId: "t2", task: "Deploy", completed: false, by: "Olga" }),
      ]);
      expect((await tracker.check()).events).toEqual([]); // consumed
    });

    it("ignores new tasks created already ticked, and unchanged tasks", async () => {
      const { w, tracker, tick } = setup();
      w.cards.push({ ...card });
      w.tasks.push(task("t1", "Same", true));
      await tracker.check();
      w.tasks.push(task("t2", "Born done", true, tick(1)));
      expect((await tracker.check()).events).toEqual([]);
    });

    it("cards from a state file without task data get a task baseline first, without events", async () => {
      const { w, f, tracker, tick } = setup();
      w.cards.push({ ...card });
      w.tasks.push(task("t1", "Old tick"));
      await tracker.check();
      // Simulate a state file written before task tracking existed.
      const { readFileSync, writeFileSync } = await import("node:fs");
      const st = JSON.parse(readFileSync(statePath, "utf8"));
      delete st.boards[BOARD].cards.c1.d;
      writeFileSync(statePath, JSON.stringify(st));
      w.tasks[0].isCompleted = true;
      tick(1);
      const fresh = new UpdateTracker(f.client, statePath, { now });
      expect((await fresh.check()).events).toEqual([]);
      w.tasks[0].isCompleted = false;
      tick(1);
      expect((await fresh.check()).events).toEqual([expect.objectContaining({ type: "task", taskId: "t1", completed: false, by: undefined })]);
    });

    it("reads each card's action log at most once per check", async () => {
      const { w, f, tracker, tick } = setup();
      w.cards.push({ ...card });
      w.tasks.push(task("t1", "A"), task("t2", "B"));
      await tracker.check();
      const at = tick(1);
      w.cards[0] = { ...w.cards[0], listId: DONE, listChangedAt: at };
      w.tasks[0].isCompleted = true;
      w.tasks[1].isCompleted = true;
      w.actions.c1 = [move(HUMAN, DOING, DONE, at), act("completeTask", HUMAN, "t1", at), act("completeTask", HUMAN, "t2", at)];
      const n = f.calls.length;
      expect((await tracker.check()).events).toHaveLength(3);
      expect(f.calls.slice(n).filter((c) => c.path === "/cards/c1/actions")).toHaveLength(1);
    });
  });

  describe("START label", () => {
    const card = (id: string, listId = BACKLOG) => ({ id, listId, name: `Card ${id}`, creatorUserId: HUMAN, createdAt: "2020-01-01T00:00:00Z" });

    it("reports cards already labelled START on a board's first check (pending work), once", async () => {
      const { w, tracker } = setup();
      w.cards.push(card("c1", DOING), card("c2"));
      w.cardLabels.push({ cardId: "c1", labelId: "L1", createdAt: "2020-01-02T00:00:00Z" }, { cardId: "c2", labelId: "L2" });
      const r = await tracker.check();
      expect(r.boards[0].initialized).toBe(true);
      expect(r.events).toEqual([
        { type: "start_request", boardId: BOARD, board: "Dev", listId: DOING, list: "Doing", cardId: "c1", name: "Card c1", labelId: "L1", label: "Start", at: "2020-01-02T00:00:00Z" },
      ]);
      expect((await tracker.check()).events).toEqual([]); // still labelled, but already reported
    });

    it("reports a newly added START label, and again if it is removed and added back", async () => {
      const { w, tracker, tick } = setup();
      w.cards.push(card("c1", DOING));
      await tracker.check();
      w.cardLabels.push({ cardId: "c1", labelId: "L1" });
      tick(1);
      expect((await tracker.check()).events).toEqual([expect.objectContaining({ type: "start_request", cardId: "c1", labelId: "L1" })]);
      w.cardLabels.length = 0;
      expect((await tracker.check()).events).toEqual([]);
      w.cardLabels.push({ cardId: "c1", labelId: "L1" });
      expect((await tracker.check()).events).toHaveLength(1);
    });

    it("uses the configured label name, case-insensitively", async () => {
      const { w, f } = setup();
      w.labels.push({ id: "L3", name: " go ", color: "sunny-grass" });
      w.cards.push(card("c1"), card("c2"));
      w.cardLabels.push({ cardId: "c1", labelId: "L1" }, { cardId: "c2", labelId: "L3" });
      const tracker = new UpdateTracker(f.client, statePath, { now, startLabel: "GO" });
      expect((await tracker.check()).events.map((e: any) => [e.cardId, e.label])).toEqual([["c2", " go "]]);
    });

    it("a new card created with START in the backlog gives both events", async () => {
      const { w, tracker, tick } = setup();
      await tracker.check();
      w.cards.push({ ...card("c1"), createdAt: tick(1) });
      w.cardLabels.push({ cardId: "c1", labelId: "L1" });
      expect((await tracker.check()).events.map((e) => e.type).sort()).toEqual(["backlog_card", "start_request"]);
    });
  });
});
