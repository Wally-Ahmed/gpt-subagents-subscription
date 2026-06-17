import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gss-"));
  process.env.GSS_TOKEN_DIR = dir;
  vi.resetModules(); // so config.ts re-reads GSS_TOKEN_DIR on next import
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.GSS_TOKEN_DIR;
  vi.restoreAllMocks();
});

// Imported fresh in each test (after env is set + modules reset).
async function freshTokens() {
  return await import("../src/tokens.js");
}

const base = {
  access_token: "AT",
  refresh_token: "RT",
  account_id: "acct_1",
  expires_at: Date.now() + 3_600_000,
};

describe("token store", () => {
  it("round-trips save -> load and clears", async () => {
    const m = await freshTokens();
    expect(m.loadTokens()).toBeNull();
    m.saveTokens(base);
    expect(m.loadTokens()).toEqual(base);
    m.clearTokens();
    expect(m.loadTokens()).toBeNull();
  });

  it("getValidAuth returns auth without refresh when token is fresh", async () => {
    const m = await freshTokens();
    m.saveTokens(base);
    expect(await m.getValidAuth()).toEqual({ accessToken: "AT", accountId: "acct_1" });
  });

  it("getValidAuth refreshes when expired and persists the new token", async () => {
    const m = await freshTokens();
    m.saveTokens({ ...base, expires_at: Date.now() - 1000 });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }),
        { status: 200 }
      )
    );
    const auth = await m.getValidAuth();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(auth.accessToken).toBe("AT2");
    expect(m.loadTokens()?.access_token).toBe("AT2");
  });

  it("getValidAuth throws NotAuthenticated when no tokens", async () => {
    const m = await freshTokens();
    await expect(m.getValidAuth()).rejects.toThrow(/not authenticated/i);
  });
});

describe("atomic write + permissions", () => {
  // Permission bits are POSIX-only; skip the mode assertions on Windows.
  const posix = process.platform !== "win32";

  it("writes auth.json with 0600 and the dir as 0700", async () => {
    const m = await freshTokens();
    m.saveTokens(base);
    const fileMode = statSync(join(dir, "auth.json")).mode & 0o777;
    const dirMode = statSync(dir).mode & 0o777;
    if (posix) {
      expect(fileMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
    }
  });

  it("tightens a pre-existing world-readable file and dir", async () => {
    if (!posix) return;
    // Simulate a loosely-permissioned prior install.
    chmodSync(dir, 0o755);
    const file = join(dir, "auth.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    expect(statSync(file).mode & 0o777).toBe(0o644);

    const m = await freshTokens();
    m.saveTokens(base);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // Rename-over replaces the old inode with the fresh 0600 temp file.
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp files behind", async () => {
    const m = await freshTokens();
    m.saveTokens(base);
    const leftover = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(leftover).toEqual([]);
  });

  it("replaces (does not follow) a symlink at the token file path", async () => {
    if (!posix) return;
    const outside = mkdtempSync(join(tmpdir(), "gss-outside-"));
    const target = join(outside, "target.json");
    writeFileSync(target, "ORIGINAL");
    const file = join(dir, "auth.json");
    symlinkSync(target, file);

    const m = await freshTokens();
    m.saveTokens(base);

    // The symlink target must be untouched; auth.json is now a real file.
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL");
    expect(statSync(file).isSymbolicLink?.() ?? false).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).access_token).toBe("AT");
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a token dir that is a symlink", async () => {
    if (!posix) return;
    // Point GSS_TOKEN_DIR at a symlink to a real directory.
    const realDir = mkdtempSync(join(tmpdir(), "gss-real-"));
    const linkDir = join(tmpdir(), `gss-link-${Date.now()}`);
    symlinkSync(realDir, linkDir);
    process.env.GSS_TOKEN_DIR = linkDir;
    vi.resetModules();
    const m = await freshTokens();
    expect(() => m.saveTokens(base)).toThrow(/symlink/i);
    rmSync(linkDir, { force: true });
    rmSync(realDir, { recursive: true, force: true });
  });
});

describe("loadTokens corruption handling", () => {
  it("throws (not null) on invalid JSON", async () => {
    const m = await freshTokens();
    writeFileSync(join(dir, "auth.json"), "{ not json", { mode: 0o600 });
    expect(() => m.loadTokens()).toThrow(/corrupt/i);
  });

  it("throws on a structurally-wrong token file", async () => {
    const m = await freshTokens();
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ access_token: "AT" }),
      { mode: 0o600 }
    );
    expect(() => m.loadTokens()).toThrow(/corrupt/i);
  });

  it("treats a non-finite expires_at as corrupt", async () => {
    const m = await freshTokens();
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ ...base, expires_at: null }),
      { mode: 0o600 }
    );
    expect(() => m.loadTokens()).toThrow(/corrupt/i);
  });
});

describe("refreshTokens validation", () => {
  it("rejects a refresh response missing access_token", async () => {
    const m = await freshTokens();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ refresh_token: "RT2", expires_in: 3600 }), { status: 200 })
    );
    await expect(m.refreshTokens(base)).rejects.toThrow(/access_token/i);
  });

  it("rejects a refresh response with a non-finite expires_in", async () => {
    const m = await freshTokens();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "AT2" }), { status: 200 })
    );
    await expect(m.refreshTokens(base)).rejects.toThrow(/expires_in/i);
  });

  it("keeps the current refresh_token when the response omits or blanks it", async () => {
    const m = await freshTokens();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "AT2", refresh_token: "", expires_in: 3600 }), {
        status: 200,
      })
    );
    const next = await m.refreshTokens(base);
    expect(next.refresh_token).toBe("RT"); // unchanged from base
    expect(next.access_token).toBe("AT2");
    expect(Number.isFinite(next.expires_at)).toBe(true);
  });

  it("adopts a rotated refresh_token when present and non-empty", async () => {
    const m = await freshTokens();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "AT2", refresh_token: "RT_NEW", expires_in: 3600 }),
        { status: 200 }
      )
    );
    const next = await m.refreshTokens(base);
    expect(next.refresh_token).toBe("RT_NEW");
  });
});

describe("concurrent refresh", () => {
  it("serializes overlapping getValidAuth refreshes into a single token request", async () => {
    const m = await freshTokens();
    m.saveTokens({ ...base, expires_at: Date.now() - 1000 });
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      // Yield so a second overlapping call can start before this resolves.
      await new Promise((r) => setTimeout(r, 20));
      return new Response(
        JSON.stringify({ access_token: "AT2", refresh_token: "RT2", expires_in: 3600 }),
        { status: 200 }
      );
    });
    const [a, b] = await Promise.all([m.getValidAuth(), m.getValidAuth()]);
    expect(calls).toBe(1);
    expect(a.accessToken).toBe("AT2");
    expect(b.accessToken).toBe("AT2");
  });
});
