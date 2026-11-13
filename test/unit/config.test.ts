import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseKeyValue } from "../../src/config.js";

const tmpFile = (content: string) => {
  const dir = mkdtempSync(join(tmpdir(), "planka-cfg-"));
  const f = join(dir, ".planka");
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
  it("reads the .planka file and strips trailing slash", () => {
    const f = tmpFile("URL=https://planka.example/\r\nKEY=secret\r\n");
    expect(loadConfig({ env: {}, files: [f] })).toEqual({ url: "https://planka.example", apiKey: "secret", managers: [] });
  });
  it("env vars override the file", () => {
    const f = tmpFile("URL=https://file\nKEY=filekey\n");
    expect(loadConfig({ env: { PLANKA_URL: "https://env", PLANKA_API_KEY: "envkey" }, files: [f] })).toEqual({
      url: "https://env",
      apiKey: "envkey",
      managers: [],
    });
  });
  it("parses MANAGERS (comma-separated); env overrides", () => {
    const f = tmpFile("URL=https://x\r\nKEY=k\r\nMANAGERS= alex , carol@x ,\r\n");
    expect(loadConfig({ env: {}, files: [f] }).managers).toEqual(["alex", "carol@x"]);
    expect(loadConfig({ env: { PLANKA_MANAGERS: "dave" }, files: [f] }).managers).toEqual(["dave"]);
  });

  it("uses the first existing candidate file", () => {
    const f = tmpFile("URL=https://second\nKEY=k\n");
    expect(loadConfig({ env: {}, files: ["/nonexistent/.planka", f] }).url).toBe("https://second");
  });
  it("throws a clear error when KEY is missing", () => {
    const f = tmpFile("URL=https://x\n");
    expect(() => loadConfig({ env: {}, files: [f] })).toThrow(ConfigError);
    expect(() => loadConfig({ env: {}, files: [f] })).toThrow(/KEY/);
  });
  it("throws when nothing is configured", () => {
    expect(() => loadConfig({ env: {}, files: [] })).toThrow(/URL.*KEY/);
  });
});
