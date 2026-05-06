import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localResolver, nodeResolver, nodeResolverAsync } from "./node-preset.ts";
import type { Module } from "./types.ts";

// --- Helpers ---

let tempDir: string | undefined;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "marinada-test-"));
  return tempDir;
}

afterEach(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function writeModule(dir: string, filename: string, mod: Module): string {
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(mod), "utf8");
  return path;
}

// --- localResolver ---

describe("localResolver", () => {
  it("reads and parses a valid Module JSON file", () => {
    const dir = makeTempDir();
    const mod: Module = { main: ["+", 1, 2], exports: ["result"] };
    writeModule(dir, "foo.json", mod);

    const resolver = localResolver(dir);
    const result = resolver("local:./foo.json");
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ main: ["+", 1, 2], exports: ["result"] });
  });

  it("returns null for paths not starting with 'local:'", () => {
    const dir = makeTempDir();
    const resolver = localResolver(dir);
    expect(resolver("lib:std")).toBeNull();
    expect(resolver("https://example.com/mod.json")).toBeNull();
  });

  it("returns null when file does not exist", () => {
    const dir = makeTempDir();
    const resolver = localResolver(dir);
    expect(resolver("local:./nonexistent.json")).toBeNull();
  });

  it("returns null when file content is not a valid Module (missing 'main')", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ notMain: true }), "utf8");
    const resolver = localResolver(dir);
    expect(resolver("local:./bad.json")).toBeNull();
  });

  it("returns null when file content is not valid JSON", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "broken.json"), "not json at all", "utf8");
    const resolver = localResolver(dir);
    expect(resolver("local:./broken.json")).toBeNull();
  });

  it("handles nested paths", () => {
    const dir = makeTempDir();
    const subdir = join(dir, "sub");
    mkdirSync(subdir, { recursive: true });
    const mod: Module = { main: null };
    writeFileSync(join(subdir, "mod.json"), JSON.stringify(mod), "utf8");

    const resolver = localResolver(dir);
    const result = resolver("local:./sub/mod.json");
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ main: null });
  });
});

// --- nodeResolver ---

describe("nodeResolver", () => {
  it("resolves 'lib:std' to a Module with std exports", () => {
    const dir = makeTempDir();
    const resolver = nodeResolver(dir);
    const result = resolver("lib:std");
    expect(result).not.toBeNull();
    const exports = result!.exports ?? [];
    expect(exports).toContain("map");
    expect(exports).toContain("filter");
    expect(exports).toContain("reduce");
  });

  it("resolves a local file via 'local:' path", () => {
    const dir = makeTempDir();
    const mod: Module = { main: 42 };
    writeModule(dir, "answer.json", mod);

    const resolver = nodeResolver(dir);
    const result = resolver("local:./answer.json");
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ main: 42 });
  });

  it("returns null for https:// (not handled by sync preset)", () => {
    const dir = makeTempDir();
    const resolver = nodeResolver(dir);
    expect(resolver("https://example.com/mod.json")).toBeNull();
  });

  it("returns null for unknown protocols", () => {
    const dir = makeTempDir();
    const resolver = nodeResolver(dir);
    expect(resolver("unknown:something")).toBeNull();
  });
});

// --- nodeResolverAsync ---

describe("nodeResolverAsync", () => {
  it("resolves 'lib:std' asynchronously", async () => {
    const dir = makeTempDir();
    const resolver = nodeResolverAsync(dir);
    const result = await resolver("lib:std");
    expect(result).not.toBeNull();
    const exports = result!.exports ?? [];
    expect(exports).toContain("map");
    expect(exports).toContain("filter");
  });

  it("resolves a local file via 'local:' path asynchronously", async () => {
    const dir = makeTempDir();
    const mod: Module = { main: "hello", exports: ["greeting"] };
    writeModule(dir, "greet.json", mod);

    const resolver = nodeResolverAsync(dir);
    const result = await resolver("local:./greet.json");
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ main: "hello", exports: ["greeting"] });
  });

  it("returns null for unknown protocols", async () => {
    const dir = makeTempDir();
    const resolver = nodeResolverAsync(dir);
    expect(await resolver("unknown:something")).toBeNull();
  });
});
