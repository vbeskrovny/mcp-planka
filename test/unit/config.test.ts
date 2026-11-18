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

describe("loadConfig", () => {
  it("reads PLANKA_ keys from the .env file and strips the trailing slash", () => {
    const f = tmpFile("PLANKA_URL=https://planka.example/\r\nPLANKA_API_KEY=secret\r\n");
    expect(loadConfig({ env: {}, files: [f] })).toEqual({ url: "https://planka.example", apiKey: "secret", managers: [] });
  });
  it("env vars override the file", () => {
    const f = tmpFile("PLANKA_URL=https://file\nPLANKA_API_KEY=filekey\n");
    expect(loadConfig({ env: { PLANKA_URL: "https://env", PLANKA_API_KEY: "envkey" }, files: [f] })).toEqual({
      url: "https://env",
      apiKey: "envkey",
      managers: [],
    });
  });
  it("parses PLANKA_MANAGERS (comma-separated); env overrides", () => {
    const f = tmpFile("PLANKA_URL=https://x\r\nPLANKA_API_KEY=k\r\nPLANKA_MANAGERS= alex , carol@x ,\r\n");
    expect(loadConfig({ env: {}, files: [f] }).managers).toEqual(["alex", "carol@x"]);
    expect(loadConfig({ env: { PLANKA_MANAGERS: "dave" }, files: [f] }).managers).toEqual(["dave"]);
  });
  it("reads PLANKA_FILES_DIR and PLANKA_INSTRUCTIONS", () => {
    const f = tmpFile("PLANKA_URL=https://x\nPLANKA_API_KEY=k\nPLANKA_FILES_DIR=/files\nPLANKA_INSTRUCTIONS=off\n");
    expect(loadConfig({ env: {}, files: [f] })).toMatchObject({ filesDir: "/files", instructions: "off" });
  });
  it("ignores unrelated keys, as in a shared .env", () => {
    const f = tmpFile("DATABASE_URL=postgres://x\nPLANKA_URL=https://x\nPLANKA_API_KEY=k\nKEYCLOAK=1\n");
    expect(loadConfig({ env: {}, files: [f] })).toEqual({ url: "https://x", apiKey: "k", managers: [] });
  });

  it("uses the first existing candidate file", () => {
    const f = tmpFile("PLANKA_URL=https://second\nPLANKA_API_KEY=k\n");
    expect(loadConfig({ env: {}, files: ["/nonexistent/.env", f] }).url).toBe("https://second");
  });
  it("by default reads only $PLANKA_CONFIG, never a .env in the current directory", () => {
    const f = tmpFile("PLANKA_URL=https://via-config\nPLANKA_API_KEY=k\n");
    expect(loadConfig({ env: { PLANKA_CONFIG: f } }).url).toBe("https://via-config");
    const cwd = process.cwd();
    const other = mkdtempSync(join(tmpdir(), "planka-cwd-"));
    writeFileSync(join(other, ".env"), "PLANKA_URL=https://from-cwd\nPLANKA_API_KEY=k\n");
    try {
      process.chdir(other);
      expect(loadConfig({ env: { PLANKA_CONFIG: f } }).url).toBe("https://via-config");
      expect(() => loadConfig({ env: { PLANKA_CONFIG: join(other, "missing.env") } })).toThrow(ConfigError);
    } finally {
      process.chdir(cwd);
    }
  });
  it("throws a clear error when PLANKA_API_KEY is missing", () => {
    const f = tmpFile("PLANKA_URL=https://x\n");
    expect(() => loadConfig({ env: {}, files: [f] })).toThrow(ConfigError);
    expect(() => loadConfig({ env: {}, files: [f] })).toThrow(/PLANKA_API_KEY/);
  });
  it("throws when nothing is configured", () => {
    expect(() => loadConfig({ env: {}, files: [] })).toThrow(/PLANKA_URL.*PLANKA_API_KEY/);
  });
  it("old key names are not read, but the error says how to migrate them", () => {
    const f = tmpFile("URL=https://x\nKEY=k\nMANAGERS=a\n");
    expect(() => loadConfig({ env: {}, files: [f] })).toThrow(/old key names \(URL, KEY, MANAGERS\).*PLANKA_URL, PLANKA_API_KEY, PLANKA_MANAGERS.*register\.sh/);
  });
  it("points to a leftover .planka next to the missing .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "planka-legacy-"));
    writeFileSync(join(dir, ".planka"), "URL=https://x\nKEY=k\n");
    expect(() => loadConfig({ env: {}, files: [join(dir, ".env")] })).toThrow(/old config .*\.planka: run \.\/register\.sh to migrate/);
  });
  it("never puts the API key into an error", () => {
    const f = tmpFile("KEY=super-secret-value\n");
    expect(() => loadConfig({ env: {}, files: [f] })).toThrow(ConfigError);
    try {
      loadConfig({ env: {}, files: [f] });
    } catch (e: any) {
      expect(e.message).not.toContain("super-secret-value");
    }
  });
});
