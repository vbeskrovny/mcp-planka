import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const SCRIPT = join(ROOT, "register.sh");
const tmp = mkdtempSync(join(tmpdir(), "register-sh-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// A fake `claude` on PATH: "mcp get" finds nothing, anything else succeeds.
const bin = join(tmp, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "claude"), '#!/bin/sh\n[ "$2" = get ] && exit 1\nexit 0\n');
chmodSync(join(bin, "claude"), 0o755);
const config = join(tmp, ".planka");
writeFileSync(config, "URL=https://planka.invalid\nKEY=dummy\n", { mode: 0o600 });
const files = join(tmp, "files");
mkdirSync(files);

/** Run register.sh; returns stdout + stderr (its [dry-run] lines go to stderr). */
function run(args: string[], env: Record<string, string> = {}) {
  const base = { ...process.env };
  delete base.PLANKA_FILES_DIR;
  const r = spawnSync("bash", [SCRIPT, "--mode", "node", "--yes", "--dry-run", ...args], {
    env: { ...base, ...env, PATH: `${bin}:${process.env.PATH}` },
    cwd: tmp,
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout + r.stderr };
}
function sh(args: string[], env: Record<string, string> = {}) {
  const r = run(args, env);
  expect(r.status, r.out).toBe(0);
  return r.out;
}
/** A config file in tmp with the given extra lines and mode. */
function cfg(name: string, extra = "", mode = 0o600) {
  const f = join(tmp, name);
  writeFileSync(f, `URL=https://planka.invalid\r\nKEY=dummy\r\n${extra}`);
  chmodSync(f, mode);
  return f;
}
const filesEnv = (add: string) => add.match(/-e PLANKA_FILES_DIR=(\S+)/)?.[1];
const addLine = (out: string) => out.split("\n").find((l) => l.startsWith("[dry-run] claude mcp add")) ?? "";

describe("register.sh (node mode, dry run)", () => {
  it("puts the server name before -e options, so a variadic -e can't swallow it", () => {
    const add = addLine(sh(["--config", config, "--name", "planka-x", "--files-dir", files]));
    expect(add).toMatch(/^\[dry-run\] claude mcp add -s user planka-x -e PLANKA_CONFIG=\S+ -e PLANKA_FILES_DIR=\S+ -- node \S+\/dist\/index\.js$/);
  });

  it("with env-only settings, the name still directly follows the scope", () => {
    const add = addLine(sh(["--scope", "local"], { PLANKA_URL: "https://planka.invalid", PLANKA_API_KEY: "x" }));
    // The repo's own .planka may exist, so -e options may or may not follow.
    expect(add).toMatch(/^\[dry-run\] claude mcp add -s local planka( -e \S+)* -- node /);
  });

  it("uses <repo>/attachments by default, so --files-dir isn't needed", () => {
    const out = sh(["--config", config]);
    expect(filesEnv(addLine(out))).toBe(join(ROOT, "attachments"));
    expect(out).toContain(`Attachment files folder: ${join(ROOT, "attachments")}`);
  });

  it("takes FILES_DIR from the config file, and PLANKA_FILES_DIR from the environment first", () => {
    const withDir = cfg(".planka-files", `FILES_DIR=${files}\r\n`);
    expect(filesEnv(addLine(sh(["--config", withDir])))).toBe(files);
    const other = join(tmp, "env-files");
    mkdirSync(other, { recursive: true });
    expect(filesEnv(addLine(sh(["--config", withDir], { PLANKA_FILES_DIR: other })))).toBe(other);
    expect(filesEnv(addLine(sh(["--config", withDir, "--files-dir", files])))).toBe(files);
  });

  it("--files-dir none registers no folder", () => {
    expect(addLine(sh(["--config", config, "--files-dir", "none"]))).not.toContain("PLANKA_FILES_DIR");
  });

  it("would create a missing folder (dry run changes nothing) and refuses a file", () => {
    const missing = join(tmp, "new-files");
    const out = sh(["--config", config, "--files-dir", missing]);
    expect(out).toContain(`[dry-run] mkdir -p ${missing}`);
    expect(out).toContain(`[dry-run] chmod 700 ${missing}`);
    expect(filesEnv(addLine(out))).toBe(missing);
    const r = run(["--config", config, "--files-dir", config]);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/files dir is not a directory/);
  });

  it("restricts a readable config to 600 (only announced in a dry run)", () => {
    const open = cfg(".planka-open", "", 0o644);
    const out = sh(["--config", open]);
    expect(out).toContain(`Restricting ${open} (644 -> 600)`);
    expect(out).toContain(`[dry-run] chmod 600 ${open}`);
    expect(statSync(open).mode & 0o777).toBe(0o644);
    expect(sh(["--config", cfg(".planka-closed")])).not.toContain("Restricting");
  });
});
