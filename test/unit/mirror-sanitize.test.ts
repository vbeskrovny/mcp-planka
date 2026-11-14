import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The sanitizer lives in .gitea/, which the GitHub mirror itself doesn't contain.
const SCRIPT = resolve(__dirname, "../../.gitea/scripts/sanitize-history.sh");
const tmp = mkdtempSync(join(tmpdir(), "mirror-sanitize-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Real Person",
  GIT_AUTHOR_EMAIL: "real@person.example",
  GIT_COMMITTER_NAME: "Real Person",
  GIT_COMMITTER_EMAIL: "real@person.example",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

function write(repo: string, file: string, content: string) {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
}

let n = 0;
function commit(repo: string, msg: string, files: Record<string, string>) {
  for (const [f, c] of Object.entries(files)) write(repo, f, c);
  git(repo, "add", "-A");
  const date = `2026-01-0${++n}T12:00:00Z`;
  execFileSync("git", ["commit", "-q", "-m", msg], {
    cwd: repo,
    env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

/** Source repo with: root commit, a fix, a co-authored feature touching .gitea, a .gitea-only commit, an annotated tag. */
function sourceRepo() {
  const repo = join(tmp, "src");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "Planka v2 MCP server\n\nlong description", { "src/a.ts": "1", ".gitea/workflows/m.yml": "x" });
  commit(repo, "Fix crash in teardown", { "src/a.ts": "2" });
  commit(repo, "Add register menu\n\nCo-authored-by: Claude <noreply@anthropic.com>", { "src/b.ts": "1", ".gitea/w2.yml": "y" });
  commit(repo, "Tweak mirror workflow", { ".gitea/workflows/m.yml": "z" });
  commit(repo, "Add push helper", { "push.sh": "#!/bin/sh", "src/a.ts": "3" });
  commit(repo, "Tweak push helper", { "push.sh": "#!/bin/sh\n" });
  git(repo, "tag", "-a", "v1.0", "-m", "Release by Real Person");
  return repo;
}

function sanitizedClone(src: string, name: string) {
  const dir = join(tmp, name);
  git(tmp, "clone", "-q", "--mirror", src, dir);
  execFileSync("bash", [SCRIPT], {
    cwd: dir,
    env: { ...ENV, MIRROR_NAME: "mirror-bot", MIRROR_EMAIL: "bot@noreply.invalid" },
    encoding: "utf8",
  });
  return dir;
}

describe.skipIf(!existsSync(SCRIPT))("mirror sanitize-history.sh", () => {
  const src = sourceRepo();
  const a = sanitizedClone(src, "a.git");

  it("replaces messages with generic ones and drops commits that only touched excluded paths", () => {
    expect(git(a, "log", "--format=%B", "main").split("\n").filter(Boolean)).toEqual([
      "Improvements",
      "Improvements",
      "Bugfix",
      "Initial commit",
    ]);
    expect(git(a, "log", "--all", "--format=%B")).not.toMatch(/Co-authored-by|Claude|Planka|teardown/i);
  });

  it("replaces author and committer but keeps the dates", () => {
    expect(new Set(git(a, "log", "--all", "--format=%an <%ae>|%cn <%ce>").split(/\n|\|/))).toEqual(
      new Set(["mirror-bot <bot@noreply.invalid>"]),
    );
    const times = (fmt: string) => git(a, "log", `--format=${fmt}`, "main").split("\n").map((d) => Date.parse(d));
    const expected = ["2026-01-05T12:00:00Z", "2026-01-03T12:00:00Z", "2026-01-02T12:00:00Z", "2026-01-01T12:00:00Z"].map((d) => Date.parse(d));
    expect(times("%aI")).toEqual(expected);
    expect(times("%cI")).toEqual(expected);
  });

  it("removes .gitea/ and push.sh from every commit and keeps the code", () => {
    const touched = git(a, "log", "--all", "--name-only", "--format=");
    expect(touched).not.toContain(".gitea/");
    expect(touched).not.toContain("push.sh");
    expect(git(a, "ls-tree", "-r", "--name-only", "main").split("\n")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(git(a, "show", "main:src/a.ts")).toBe("3");
  });

  it("honours a custom EXCLUDE_PATHS list", () => {
    const d = join(tmp, "d.git");
    git(tmp, "clone", "-q", "--mirror", src, d);
    execFileSync("bash", [SCRIPT], { cwd: d, env: { ...ENV, EXCLUDE_PATHS: "src/b.ts .gitea" } });
    expect(git(d, "ls-tree", "-r", "--name-only", "main").split("\n")).toEqual(["push.sh", "src/a.ts"]);
    expect(git(d, "log", "--all", "--name-only", "--format=")).not.toContain("src/b.ts");
  });

  it("turns annotated tags into lightweight tags on the rewritten commit", () => {
    expect(git(a, "cat-file", "-t", "refs/tags/v1.0")).toBe("commit");
    expect(git(a, "rev-parse", "refs/tags/v1.0")).toBe(git(a, "rev-parse", "main"));
  });

  it("is deterministic: the same history gives the same commit IDs", () => {
    const b = sanitizedClone(src, "b.git");
    expect(git(b, "rev-parse", "main")).toBe(git(a, "rev-parse", "main"));
  });

  it("drops refs other than branches and tags", () => {
    const c = join(tmp, "c.git");
    git(tmp, "clone", "-q", "--mirror", src, c);
    git(c, "update-ref", "refs/pull/1/head", "main");
    execFileSync("bash", [SCRIPT], { cwd: c, env: ENV });
    expect(git(c, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main\nrefs/tags/v1.0");
  });
});
