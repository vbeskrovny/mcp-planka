import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const SCRIPT = resolve(__dirname, "../../scripts/migrate-config.sh");
const tmp = mkdtempSync(join(tmpdir(), "migrate-config-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const dir = () => mkdtempSync(join(tmp, `d${++n}-`));
const migrate = (src: string, dest: string, ...opts: string[]) => {
  const r = spawnSync("bash", [SCRIPT, ...opts, src, dest], { encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
};
const SECRET = "s3cr3t==value";
const LEGACY = `URL = https://planka.example/\r\nKEY=${SECRET}\r\n# who gets editor rights\r\nMANAGERS=bb@x.de\r\nINSTRUCTIONS=off\r\nFILES_DIR=/srv/files\r\n`;

describe("scripts/migrate-config.sh", () => {
  it("moves .planka to .env with MCP_APP_PLANKA_ keys, mode 600, and deletes .planka", () => {
    const d = dir();
    writeFileSync(join(d, ".planka"), LEGACY, { mode: 0o644 });
    const r = migrate(join(d, ".planka"), join(d, ".env"));
    expect(r.status, r.out).toBe(0);
    expect(existsSync(join(d, ".planka"))).toBe(false);
    const env = readFileSync(join(d, ".env"), "utf8");
    expect(env).toBe(
      `MCP_APP_PLANKA_URL=https://planka.example/\nMCP_APP_PLANKA_API_KEY=${SECRET}\n# who gets editor rights\nMCP_APP_PLANKA_MANAGERS=bb@x.de\nMCP_APP_PLANKA_INSTRUCTIONS=off\nMCP_APP_PLANKA_FILES_DIR=/srv/files\n`,
    );
    expect(statSync(join(d, ".env")).mode & 0o777).toBe(0o600);
    expect(loadConfig({ env: {}, files: [join(d, ".env")] })).toEqual({
      url: "https://planka.example", apiKey: SECRET, managers: ["bb@x.de"], instructions: "off", filesDir: "/srv/files",
    });
  });

  it("never prints values", () => {
    const d = dir();
    writeFileSync(join(d, ".planka"), LEGACY);
    expect(migrate(join(d, ".planka"), join(d, ".env")).out).not.toContain(SECRET);
    writeFileSync(join(d, ".planka"), `KEY=other\n`);
    const conflict = migrate(join(d, ".planka"), join(d, ".env"));
    expect(conflict.out).not.toContain(SECRET);
    expect(conflict.out).not.toContain("other");
  });

  it("merges into an existing .env, keeping its other settings", () => {
    const d = dir();
    writeFileSync(join(d, ".env"), "DATABASE_URL=postgres://db\nMCP_APP_PLANKA_URL=https://planka.example/");
    writeFileSync(join(d, ".planka"), LEGACY);
    const r = migrate(join(d, ".planka"), join(d, ".env"));
    expect(r.status, r.out).toBe(0);
    const env = readFileSync(join(d, ".env"), "utf8");
    expect(env.startsWith("DATABASE_URL=postgres://db\nMCP_APP_PLANKA_URL=https://planka.example/\n# mcp-planka (migrated from .planka)\n")).toBe(true);
    expect(env.match(/MCP_APP_PLANKA_URL=/g)).toHaveLength(1);
    expect(env).toContain(`MCP_APP_PLANKA_API_KEY=${SECRET}\n`);
    expect(existsSync(join(d, ".planka"))).toBe(false);
  });

  it("refuses a conflicting value and changes nothing", () => {
    const d = dir();
    writeFileSync(join(d, ".env"), "MCP_APP_PLANKA_URL=https://elsewhere\n");
    writeFileSync(join(d, ".planka"), LEGACY);
    const r = migrate(join(d, ".planka"), join(d, ".env"));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/MCP_APP_PLANKA_URL is set to a different value/);
    expect(readFileSync(join(d, ".env"), "utf8")).toBe("MCP_APP_PLANKA_URL=https://elsewhere\n");
    expect(readFileSync(join(d, ".planka"), "utf8")).toBe(LEGACY);
    expect(readFileSync(join(d, ".env"), "utf8")).not.toContain(SECRET);
  });

  it("renames keys in place for a custom config file", () => {
    const d = dir();
    const f = join(d, "me.env");
    writeFileSync(f, "URL=https://x\nKEY=k\nOTHER=1\n");
    expect(migrate(f, f).status).toBe(0);
    expect(readFileSync(f, "utf8")).toBe("MCP_APP_PLANKA_URL=https://x\nMCP_APP_PLANKA_API_KEY=k\nOTHER=1\n");
    expect(migrate(f, f).status).toBe(3); // nothing left to do
  });

  it("fails for a missing source", () => {
    const d = dir();
    expect(migrate(join(d, ".planka"), join(d, ".env")).status).toBe(1);
  });

  it("renames yesterday's PLANKA_ keys (all settings) in place, leaving other keys alone", () => {
    const d = dir();
    const f = join(d, ".env");
    writeFileSync(f, "OTHER_APP_URL=https://o\nPLANKA_URL=https://x\nPLANKA_API_KEY=k\nPLANKA_STATE_DIR=/s\nPLANKA_WATCH_INTERVAL=30\nMCP_APP_MAIL_KEY=m\n");
    expect(migrate(f, f, "--no-bare").status).toBe(0);
    expect(readFileSync(f, "utf8")).toBe(
      "OTHER_APP_URL=https://o\nMCP_APP_PLANKA_URL=https://x\nMCP_APP_PLANKA_API_KEY=k\nMCP_APP_PLANKA_STATE_DIR=/s\nMCP_APP_PLANKA_WATCH_INTERVAL=30\nMCP_APP_MAIL_KEY=m\n",
    );
    expect(loadConfig({ env: {}, files: [f] })).toMatchObject({ url: "https://x", stateDir: "/s", watchInterval: 30 });
  });

  it("--no-bare leaves bare URL= / KEY= alone (they may belong to another app in a shared .env)", () => {
    const d = dir();
    const f = join(d, ".env");
    writeFileSync(f, "URL=https://other-app\nKEY=other\nPLANKA_URL=https://x\n");
    expect(migrate(f, f, "--no-bare").status).toBe(0);
    expect(readFileSync(f, "utf8")).toBe("URL=https://other-app\nKEY=other\nMCP_APP_PLANKA_URL=https://x\n");
    writeFileSync(f, "URL=https://other-app\nKEY=other\n");
    expect(migrate(f, f, "--no-bare").status).toBe(3); // nothing of ours to migrate
  });
});
