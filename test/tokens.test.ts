import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
