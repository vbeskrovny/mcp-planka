import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { DEFAULT_INSTRUCTIONS, resolveInstructions } from "../../src/instructions.js";
import { connect, fakePlanka } from "../helpers.js";

const tmp = mkdtempSync(join(tmpdir(), "planka-instr-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("resolveInstructions", () => {
  it("uses the built-in rules when unset, empty or 'default'", () => {
    for (const s of [undefined, "", "  ", "default", "DEFAULT"]) expect(resolveInstructions(s)).toBe(DEFAULT_INSTRUCTIONS);
  });

  it("sends nothing for off/none/false/0", () => {
    for (const s of ["off", "OFF", "none", "false", "0"]) expect(resolveInstructions(s)).toBeUndefined();
  });

  it("reads a custom file, and treats an empty file as no instructions", () => {
    const f = join(tmp, "rules.md");
    writeFileSync(f, "\n  Track work on board X.\n");
    expect(resolveInstructions(f)).toBe("Track work on board X.");
    const empty = join(tmp, "empty.md");
    writeFileSync(empty, "  \n");
    expect(resolveInstructions(empty)).toBeUndefined();
  });

  it("fails clearly for a missing file", () => {
    expect(() => resolveInstructions(join(tmp, "nope.md"))).toThrow(/INSTRUCTIONS file not found/);
  });
});

describe("DEFAULT_INSTRUCTIONS", () => {
  it("only names tools the server actually registers", async () => {
    const { client } = await connect(fakePlanka({}).client);
    const registered = new Set((await client.listTools()).tools.map((t) => t.name));
    const mentioned = [...new Set(DEFAULT_INSTRUCTIONS.match(/planka_[a-z_]+/g) ?? [])];
    expect(mentioned.length).toBeGreaterThan(5);
    expect(mentioned.filter((t) => !registered.has(t))).toEqual([]);
  });

  it("contains the backlog rules: backlog at start, comments before moving, ask before creating", () => {
    expect(DEFAULT_INSTRUCTIONS).toMatch(/Session start:.*planka_get_board.*Backlog/s);
    expect(DEFAULT_INSTRUCTIONS).toMatch(/Before moving a card to another list.*planka_get_card.*new comments/s);
    expect(DEFAULT_INSTRUCTIONS).toMatch(/No match: ask the user once whether to create the project/);
  });

  it("START-labelled cards come first: move to In Progress, then remove the label", () => {
    expect(DEFAULT_INSTRUCTIONS).toMatch(/priority order: first cards labelled START, then cards already under way/);
    const rule = DEFAULT_INSTRUCTIONS.split("\n").find((l) => l.startsWith("- START label:")) ?? "";
    expect(rule).toMatch(/start_request/);
    expect(rule).toMatch(/move it to In Progress, remove the START label with planka_remove_label_from_card/);
    expect(rule).toMatch(/only after the card is in In Progress/);
  });

  it("tells the assistant to handle moved cards and ticked tasks from check_updates", () => {
    expect(DEFAULT_INSTRUCTIONS).toMatch(/Session start:.*card_moved.*task/s);
  });

  it("reminds the user at session start how to enable automatic checks, without starting them", () => {
    const rule = DEFAULT_INSTRUCTIONS.split("\n").find((l) => l.includes("automatic checking is off")) ?? "";
    expect(rule).toMatch(/session start/i);
    expect(rule).toMatch(/unless a Planka loop or watcher is already running/);
    expect(rule).toContain("/loop 1m check planka updates and reply to new comments");
    expect(rule).toMatch(/watch\.js --project <projectId> --interval 30/);
    expect(rule).toMatch(/Don't start either yourself/);
  });

  it("only suggests watcher intervals the watcher accepts (>= 10 s)", () => {
    const intervals = [...DEFAULT_INSTRUCTIONS.matchAll(/--interval (\d+)/g)].map((m) => Number(m[1]));
    expect(intervals.length).toBeGreaterThan(0);
    for (const n of intervals) expect(n).toBeGreaterThanOrEqual(10);
  });
});

describe("server instructions", () => {
  it("are sent to the client at connect time", async () => {
    const { client } = await connect(fakePlanka({}).client, { instructions: "Rule A" });
    expect(client.getInstructions()).toBe("Rule A");
  });

  it("are absent when not configured", async () => {
    const { client } = await connect(fakePlanka({}).client);
    expect(client.getInstructions()).toBeUndefined();
  });
});

describe("loadConfig instructions setting", () => {
  it("reads INSTRUCTIONS from the file, and PLANKA_INSTRUCTIONS from env wins", () => {
    const f = join(tmp, ".planka");
    writeFileSync(f, "URL=https://x\r\nKEY=k\r\nINSTRUCTIONS=off\r\n");
    expect(loadConfig({ env: {}, files: [f] }).instructions).toBe("off");
    expect(loadConfig({ env: { PLANKA_INSTRUCTIONS: "/r.md" }, files: [f] }).instructions).toBe("/r.md");
  });

  it("leaves it undefined when not set", () => {
    const f = join(tmp, ".planka2");
    writeFileSync(f, "URL=https://x\nKEY=k\n");
    expect(loadConfig({ env: {}, files: [f] }).instructions).toBeUndefined();
  });
});
