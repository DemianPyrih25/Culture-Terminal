// Accounts: password hashing and verify, the signup/login input rules, the `next` redirect guard, the
// session cookie, the attempt limiter and the proxy's gated paths. No database; invented emails only.
import { describe, expect, it } from "vitest";
import { isGatedPath } from "../../proxy";
import { hashPassword, verifyPassword } from "../../server/auth/password";
import { AttemptLimiter } from "../../server/auth/rate-limit";
import { clearedSessionCookie, isWellFormedToken, newSessionToken, sessionCookie, sessionIdFor } from "../../server/auth/session";
import { fieldErrors, LoginInput, safeNext, SignupInput } from "../../server/auth/validate";

describe("password hashing", () => {
  it("stores scrypt$N$r$p$salt$hash and verifies only the right password", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password here")).not.toBe(await hashPassword("same password here"));
  });

  it("never matches a malformed hash", async () => {
    for (const bad of ["", "plain", "scrypt$1$8$1$abc$def", "bcrypt$16384$8$1$abc$def", "scrypt$16384$8$1$$"]) {
      expect(await verifyPassword("anything at all", bad)).toBe(false);
    }
  });
});

describe("signup and login input", () => {
  it("accepts a valid signup and lowercases the email", () => {
    const r = SignupInput.safeParse({ name: "  Ada Example ", email: " Ada@Example.COM ", password: "0123456789" });
    expect(r.success && r.data).toEqual({ name: "Ada Example", email: "ada@example.com", password: "0123456789" });
  });

  it("names each bad field", () => {
    const r = SignupInput.safeParse({ name: "", email: "not-an-email", password: "short" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const f = fieldErrors(r.error);
      expect(Object.keys(f).sort()).toEqual(["email", "name", "password"]);
      expect(f.password).toContain("10");
    }
  });

  it("refuses a name over 80 characters and an email without a domain", () => {
    expect(SignupInput.safeParse({ name: "x".repeat(81), email: "a@b.co", password: "0123456789" }).success).toBe(false);
    expect(SignupInput.safeParse({ name: "A", email: "a@b", password: "0123456789" }).success).toBe(false);
  });

  it("login needs an email and a password but no minimum length", () => {
    expect(LoginInput.safeParse({ email: "a@example.com", password: "x" }).success).toBe(true);
    expect(LoginInput.safeParse({ email: "a@example.com", password: "" }).success).toBe(false);
  });
});

describe("next redirect", () => {
  it("keeps same-site paths and refuses everything else", () => {
    expect(safeNext("/briefs?x=1")).toBe("/briefs?x=1");
    expect(safeNext(undefined)).toBe("/home");
    expect(safeNext("https://evil.example")).toBe("/home");
    expect(safeNext("//evil.example")).toBe("/home");
    expect(safeNext("/\\evil.example")).toBe("/home");
    expect(safeNext("/login?next=/x")).toBe("/home");
  });
});

describe("session cookie", () => {
  it("is httpOnly, lax, 30 days, Secure only in production, and stores a hash", () => {
    const token = newSessionToken();
    expect(isWellFormedToken(token)).toBe(true);
    expect(isWellFormedToken("x")).toBe(false);
    expect(sessionIdFor(token)).toMatch(/^[0-9a-f]{64}$/);
    const dev = sessionCookie(token, { NODE_ENV: "development" } as NodeJS.ProcessEnv);
    expect(dev).toContain("HttpOnly");
    expect(dev).toContain("SameSite=Lax");
    expect(dev).toContain(`Max-Age=${30 * 24 * 3600}`);
    expect(dev).not.toContain("Secure");
    expect(sessionCookie(token, { NODE_ENV: "production" } as NodeJS.ProcessEnv)).toContain("Secure");
    expect(clearedSessionCookie()).toContain("Max-Age=0");
  });
});

describe("attempt limiter", () => {
  it("allows max attempts per window, then says when to retry", () => {
    let t = 0;
    const l = new AttemptLimiter({ max: 2, windowMs: 60_000 }, () => t);
    expect(l.hit("ip:a")).toBe(0);
    expect(l.hit("ip:a")).toBe(0);
    expect(l.hit("ip:a")).toBe(60);
    expect(l.hit("ip:b")).toBe(0);
    t = 60_001;
    expect(l.hit("ip:a")).toBe(0);
  });
});

describe("proxy gate", () => {
  it("gates app routes and leaves public ones open", () => {
    for (const p of ["/home", "/ask", "/run/abc", "/briefs", "/following", "/screener", "/d", "/d/lumen", "/settings", "/settings/account"]) {
      expect(isGatedPath(p), p).toBe(true);
    }
    for (const p of ["/", "/welcome", "/login", "/signup", "/how-it-works", "/method", "/status", "/trust", "/r/abc", "/homepage", "/dev/x"]) {
      expect(isGatedPath(p), p).toBe(false);
    }
  });
});
