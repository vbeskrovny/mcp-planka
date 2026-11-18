import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { copyFileSync, existsSync } from "node:fs";
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
const config = join(tmp, "test.env");
writeFileSync(config, "PLANKA_URL=https://planka.invalid\nPLANKA_API_KEY=dummy\n", { mode: 0o600 });
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
  writeFileSync(f, `PLANKA_URL=https://planka.invalid\r\nPLANKA_API_KEY=dummy\r\n${extra}`);
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
    // The repo's own .env may exist, so -e options may or may not follow.
    expect(add).toMatch(/^\[dry-run\] claude mcp add -s local planka( -e \S+)* -- node /);
  });

  it("uses <repo>/attachments by default, so --files-dir isn't needed", () => {
    const out = sh(["--config", config]);
    expect(filesEnv(addLine(out))).toBe(join(ROOT, "attachments"));
    expect(out).toContain(`Attachment files folder: ${join(ROOT, "attachments")}`);
  });

  it("takes PLANKA_FILES_DIR from the config file, and from the environment first", () => {
    const withDir = cfg("files.env", `PLANKA_FILES_DIR=${files}\r\n`);
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
    const open = cfg("open.env", "", 0o644);
    const out = sh(["--config", open]);
    expect(out).toContain(`Restricting ${open} (644 -> 600)`);
    expect(out).toContain(`[dry-run] chmod 600 ${open}`);
    expect(statSync(open).mode & 0o777).toBe(0o644);
    expect(sh(["--config", cfg("closed.env")])).not.toContain("Restricting");
  });

  it("migrates a custom config with old key names in place (only announced in a dry run)", () => {
    const old = join(tmp, "old.env");
    writeFileSync(old, "URL=https://planka.invalid\nKEY=dummy\n", { mode: 0o600 });
    const out = sh(["--config", old]);
    expect(out).toContain(`[dry-run] migrate ${old} -> ${old} (PLANKA_ keys)`);
    expect(readFileSync(old, "utf8")).toBe("URL=https://planka.invalid\nKEY=dummy\n");
  });

  it("real run in a fresh checkout: migrates .planka to .env, deletes .planka, registers .env", () => {
    // A minimal repo: the real register.sh and migration script, a stub server, empty src/ and node_modules/.
    const repo = join(tmp, "repo");
    for (const d of ["scripts", "dist", "src", "node_modules"]) mkdirSync(join(repo, d), { recursive: true });
    copyFileSync(SCRIPT, join(repo, "register.sh"));
    copyFileSync(join(ROOT, "scripts/migrate-config.sh"), join(repo, "scripts/migrate-config.sh"));
    writeFileSync(join(repo, "dist/index.js"), "");
    writeFileSync(join(repo, "dist/check.js"), 'console.log("OK: stub");');
    writeFileSync(join(repo, ".planka"), "URL=https://planka.invalid\r\nKEY=dummy-key\r\nMANAGERS=bb@x.de\r\n", { mode: 0o644 });
    const log = join(tmp, "claude.log");
    // Fake claude: records "mcp add"; "mcp get" fails until something was added.
    writeFileSync(join(bin, "claude"), `#!/bin/sh\n[ "$2" = get ] && { [ -f ${log} ] && exit 0; exit 1; }\n[ "$2" = add ] && echo "$@" >> ${log}\nexit 0\n`);
    const base = { ...process.env };
    delete base.PLANKA_FILES_DIR;
    const r = spawnSync("bash", [join(repo, "register.sh"), "--mode", "node", "--yes"], {
      env: { ...base, PATH: `${bin}:${process.env.PATH}` }, cwd: tmp, encoding: "utf8",
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("dummy-key");
    expect(existsSync(join(repo, ".planka"))).toBe(false);
    expect(readFileSync(join(repo, ".env"), "utf8")).toBe("PLANKA_URL=https://planka.invalid\nPLANKA_API_KEY=dummy-key\nPLANKA_MANAGERS=bb@x.de\n");
    expect(statSync(join(repo, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(log, "utf8")).toMatch(/^mcp add -s user planka -e PLANKA_CONFIG=\S+\/\.env -e PLANKA_FILES_DIR=\S+\/attachments -- node /);
    // Second run: nothing left to migrate, same registration.
    const again = spawnSync("bash", [join(repo, "register.sh"), "--mode", "node", "--yes"], {
      env: { ...base, PATH: `${bin}:${process.env.PATH}` }, cwd: tmp, encoding: "utf8",
    });
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout + again.stderr).not.toMatch(/migrate/i);
  });
});
