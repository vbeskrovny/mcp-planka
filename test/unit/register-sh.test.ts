import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../../register.sh");
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
function sh(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, "--mode", "node", "--yes", "--dry-run", ...args], {
    env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout + r.stderr;
}
const addLine = (out: string) => out.split("\n").find((l) => l.startsWith("[dry-run] claude mcp add")) ?? "";

describe("register.sh (node mode, dry run)", () => {
  it("puts the server name before -e options, so a variadic -e can't swallow it", () => {
    const add = addLine(sh(["--config", config, "--name", "planka-x", "--files-dir", files]));
    expect(add).toMatch(/^\[dry-run\] claude mcp add -s user planka-x -e PLANKA_CONFIG=\S+ -e PLANKA_FILES_DIR=\S+ -- node \S+\/dist\/index\.js$/);
  });

  it("works without -e options too", () => {
    const add = addLine(sh(["--scope", "local"], { PLANKA_URL: "https://planka.invalid", PLANKA_API_KEY: "x" }));
    // The repo's own .planka may exist; either way the name directly follows the scope.
    expect(add).toMatch(/^\[dry-run\] claude mcp add -s local planka( -e \S+)* -- node /);
  });
});
