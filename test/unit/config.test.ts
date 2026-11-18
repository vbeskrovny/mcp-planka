import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseKeyValue } from "../../src/config.js";

const tmpFile = (content: string) => {
  const dir = mkdtempSync(join(tmpdir(), "planka-cfg-"));
  const f = join(dir, ".env");
  writeFileSync(f, content);
  return f;
};

describe("parseKeyValue", () => {
  it("parses LF files", () => {
    expect(parseKeyValue("URL=https://x\nKEY=abc\n")).toEqual({ URL: "https://x", KEY: "abc" });
  });
  it("parses CRLF files without leaking \\r into values", () => {
    expect(parseKeyValue("URL=https://x\r\nKEY=abc\r\n")).toEqual({ URL: "https://x", KEY: "abc" });
  });
  it("trims whitespace around = and ignores comments/blank lines", () => {
    expect(parseKeyValue("# c\n\n URL = https://x \nKEY =abc")).toEqual({ URL: "https://x", KEY: "abc" });
  });
  it("keeps = inside values", () => {
    expect(parseKeyValue("KEY=ab==cd=")).toEqual({ KEY: "ab==cd=" });
  });
  it("strips surrounding quotes", () => {
    expect(parseKeyValue(`KEY="abc"\nURL='https://x'`)).toEqual({ KEY: "abc", URL: "https://x" });
  });
});

const P = "MCP_APP_PLANKA_";
const base = `${P}URL=https://x\n${P}API_KEY=k\n`;

describe("loadConfig", () => {
  it("reads MCP_APP_PLANKA_ keys from the .env file and strips the trailing slash", () => {
    const f = tmpFile(`${P}URL=https://planka.example/\r\n${P}API_KEY=secret\r\n`);
    expect(loadConfig({ env: {}, files: [f] })).toEqual({ url: "https://planka.example", apiKey: "secret", managers: [] });
  });
  it("env vars override the file", () => {
    const f = tmpFile(`${P}URL=https://file\n${P}API_KEY=filekey\n`);
    expect(loadConfig({ env: { [`${P}URL`]: "https://env", [`${P}API_KEY`]: "envkey" }, files: [f] })).toEqual({
      url: "https://env",
      apiKey: "envkey",
      managers: [],
    });
  });
  it("parses MANAGERS (comma-separated); env overrides", () => {
    const f = tmpFile(`${base}${P}MANAGERS= alex , carol@x ,\r\n`);
    expect(loadConfig({ env: {}, files: [f] }).managers).toEqual(["alex", "carol@x"]);
    expect(loadConfig({ env: { [`${P}MANAGERS`]: "dave" }, files: [f] }).managers).toEqual(["dave"]);
  });
  it("reads every optional setting from the file, the environment first", () => {
    const f = tmpFile(
      `${base}${P}FILES_DIR=/files\n${P}INSTRUCTIONS=off\n${P}STATE_DIR=/state\n${P}BACKLOG_PATTERN=inbox|todo\n` +
        `${P}START_LABEL=GO\n${P}WATCH_INTERVAL=30\n`,
    );
    expect(loadConfig({ env: {}, files: [f] })).toEqual({
      url: "https://x", apiKey: "k", managers: [], filesDir: "/files", instructions: "off", stateDir: "/state",
      backlogPattern: "inbox|todo", startLabel: "GO", watchInterval: 30,
    });
    expect(loadConfig({ env: { [`${P}STATE_DIR`]: "/env-state", [`${P}WATCH_INTERVAL`]: "15" }, files: [f] })).toMatchObject({
      stateDir: "/env-state", watchInterval: 15,
    });
  });
  it("rejects a watch interval below 10 s or not a number", () => {
    for (const v of ["5", "abc"]) {
      expect(() => loadConfig({ env: {}, files: [tmpFile(`${base}${P}WATCH_INTERVAL=${v}\n`)] })).toThrow(/WATCH_INTERVAL must be/);
    }
  });
  it("ignores unrelated keys, as in a .env shared with other apps", () => {
    const f = tmpFile(`DATABASE_URL=postgres://x\nURL=https://other-app\nKEY=other\nMCP_APP_MAIL_URL=https://mail\n${base}`);
    expect(loadConfig({ env: {}, files: [f] })).toEqual({ url: "https://x", apiKey: "k", managers: [] });
  });

  it("uses the first existing candidate file", () => {
    const f = tmpFile(`${P}URL=https://second\n${P}API_KEY=k\n`);
    expect(loadConfig({ env: {}, files: ["/nonexistent/.env", f] }).url).toBe("https://second");
  });
  it("by default reads only $MCP_APP_PLANKA_CONFIG, never a .env in the current directory", () => {
    const f = tmpFile(`${P}URL=https://via-config\n${P}API_KEY=k\n`);
    expect(loadConfig({ env: { [`${P}CONFIG`]: f } }).url).toBe("https://via-config");
    const cwd = process.cwd();
    const other = mkdtempSync(join(tmpdir(), "planka-cwd-"));
    writeFileSync(join(other, ".env"), `${P}URL=https://from-cwd\n${P}API_KEY=k\n`);
    try {
      process.chdir(other);
      expect(loadConfig({ env: { [`${P}CONFIG`]: f } }).url).toBe("https://via-config");
      expect(() => loadConfig({ env: { [`${P}CONFIG`]: join(other, "missing.env") } })).toThrow(ConfigError);
    } finally {
      process.chdir(cwd);
    }
  });
  it("throws a clear error when the API key is missing", () => {
    const f = tmpFile(`${P}URL=https://x\n`);
    expect(() => loadConfig({ env: {}, files: [f] })).toThrow(ConfigError);
    expect(() => loadConfig({ env: {}, files: [f] })).toThrow(/MCP_APP_PLANKA_API_KEY/);
  });
  it("throws when nothing is configured", () => {
    expect(() => loadConfig({ env: {}, files: [] })).toThrow(/MCP_APP_PLANKA_URL.*MCP_APP_PLANKA_API_KEY/);
  });

  describe("old names", () => {
    it("PLANKA_ keys in .env are not read; the error names them and their new names", () => {
      const f = tmpFile("PLANKA_URL=https://x\nPLANKA_API_KEY=k\nPLANKA_STATE_DIR=/s\n");
      expect(() => loadConfig({ env: {}, files: [f] })).toThrow(
        /old key names \(PLANKA_URL -> MCP_APP_PLANKA_URL, PLANKA_API_KEY -> MCP_APP_PLANKA_API_KEY, PLANKA_STATE_DIR -> MCP_APP_PLANKA_STATE_DIR\).*register\.sh/,
      );
    });
    it("bare keys count as old names only in a .planka file, not in a shared .env", () => {
      const dir = mkdtempSync(join(tmpdir(), "planka-bare-"));
      writeFileSync(join(dir, ".planka"), "URL=https://x\nKEY=k\n");
      expect(() => loadConfig({ env: {}, files: [join(dir, ".planka")] })).toThrow(/old key names \(URL -> MCP_APP_PLANKA_URL, KEY -> MCP_APP_PLANKA_API_KEY\)/);
      const shared = tmpFile("URL=https://other-app\nKEY=other\n");
      expect(() => loadConfig({ env: {}, files: [shared] })).toThrow(ConfigError);
      expect(() => loadConfig({ env: {}, files: [shared] })).not.toThrow(/old key names/);
    });
    it("old environment variable names are named in the error", () => {
      expect(() => loadConfig({ env: { PLANKA_URL: "https://x", PLANKA_API_KEY: "k" }, files: [] })).toThrow(
        /Old environment variable names are set \(PLANKA_URL -> MCP_APP_PLANKA_URL, PLANKA_API_KEY -> MCP_APP_PLANKA_API_KEY\)/,
      );
    });
    it("points to a leftover .planka next to the missing .env", () => {
      const dir = mkdtempSync(join(tmpdir(), "planka-legacy-"));
      writeFileSync(join(dir, ".planka"), "URL=https://x\nKEY=k\n");
      expect(() => loadConfig({ env: {}, files: [join(dir, ".env")] })).toThrow(/old config .*\.planka: run \.\/register\.sh to migrate/);
    });
    it("never puts a value into an error", () => {
      const f = tmpFile("PLANKA_API_KEY=super-secret-value\n");
      try {
        loadConfig({ env: { PLANKA_URL: "https://secret-host" }, files: [f] });
        expect.unreachable();
      } catch (e: any) {
        expect(e.message).not.toContain("super-secret-value");
        expect(e.message).not.toContain("secret-host");
      }
    });
  });
});
