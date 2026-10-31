"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/fields";
import { Icon } from "../ui/icons";

type Mode = "signup" | "login";

const PASSWORD_MIN = 10;

interface ApiError {
  error?: string;
  fields?: Record<string, string>;
}

/** Client-side checks that mirror the server's, so most mistakes show before a round trip. */
function check(mode: Mode, v: { name: string; email: string; password: string }): Record<string, string> {
  const out: Record<string, string> = {};
  if (mode === "signup" && v.name.trim() === "") out.name = "Enter your name.";
  if (mode === "signup" && v.name.trim().length > 80) out.name = "Use at most 80 characters.";
  if (v.email.trim() === "") out.email = "Enter your email address.";
  else if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v.email.trim())) out.email = "Enter a valid email address, like name@company.com.";
  if (v.password === "") out.password = mode === "signup" ? "Choose a password." : "Enter your password.";
  else if (mode === "signup" && v.password.length < PASSWORD_MIN) out.password = `Use at least ${PASSWORD_MIN} characters.`;
  return out;
}

/** The create-account and sign-in form: inline errors, a busy button, then the `next` page. */
export function AuthForm({ mode, next }: { mode: Mode; next: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const local = check(mode, { name, email, password });
    setFields(local);
    setError(null);
    if (Object.keys(local).length > 0) return;
    setBusy(true);
    try {
      const res = await fetch(mode === "signup" ? "/api/auth/signup" : "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "signup" ? { name, email, password } : { email, password }),
      });
      if (res.ok) {
        // A full navigation, so the server renders the next page with the new session cookie.
        window.location.assign(next);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as ApiError;
      setFields(body.fields ?? {});
      setError(body.fields && Object.keys(body.fields).length > 0 && res.status === 400 ? null : (body.error ?? "Something went wrong. Please try again."));
    } catch {
      setError("We could not reach Culture Terminal. Check your connection and try again.");
    }
    setBusy(false);
  }

  const nextQuery = next === "/home" ? "" : `?next=${encodeURIComponent(next)}`;

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-5" data-testid={`${mode}-form`}>
      {error ? (
        <div role="alert" className="flex animate-rise gap-2.5 rounded-sm border border-danger bg-danger-soft px-3.5 py-3 text-danger-ink">
          <Icon name="triangle-alert" size={16} className="mt-0.5 shrink-0" />
          <p className="type-body">{error}</p>
        </div>
      ) : null}
      {mode === "signup" ? (
        <Input
          label="Full name"
          name="name"
          autoComplete="name"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={fields.name}
          placeholder="Your name"
        />
      ) : null}
      <Input
        label={mode === "signup" ? "Work email" : "Email"}
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={fields.email}
        placeholder="name@company.com"
      />
      <div className="relative">
        <Input
          label="Password"
          name="password"
          type={show ? "text" : "password"}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fields.password}
          help={mode === "signup" ? `At least ${PASSWORD_MIN} characters.` : undefined}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="type-caption absolute top-0 right-0 rounded-sm text-accent-ink transition-opacity duration-150 hover:underline active:opacity-70"
          aria-pressed={show}
        >
          {show ? "Hide" : "Show"}
        </button>
      </div>
      <Button type="submit" variant="primary" size="lg" fullWidth loading={busy} disabled={busy} className="mt-1 justify-center">
        {busy ? (mode === "signup" ? "Creating account…" : "Signing in…") : mode === "signup" ? "Create account" : "Sign in"}
      </Button>
      <p className="type-body text-center text-ink-2">
        {mode === "signup" ? "Already have an account? " : "New to Culture Terminal? "}
        <Link href={`${mode === "signup" ? "/login" : "/signup"}${nextQuery}`} className="font-medium text-accent-ink hover:underline">
          {mode === "signup" ? "Sign in" : "Create an account"}
        </Link>
      </p>
    </form>
  );
}
