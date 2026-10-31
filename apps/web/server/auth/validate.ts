import { z } from "zod";

// Input rules shared by the auth API and its tests. Messages are shown to the person as written.

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
export const NAME_MAX = 80;
export const EMAIL_MAX = 254;

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const email = z
  .string({ message: "Enter your email address." })
  .trim()
  .min(1, "Enter your email address.")
  .max(EMAIL_MAX, "That email address is too long.")
  .refine((v) => EMAIL_RE.test(v), "Enter a valid email address, like name@company.com.")
  .transform((v) => v.toLowerCase());

const newPassword = z
  .string({ message: "Choose a password." })
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters.`)
  .max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters.`);

const name = z
  .string({ message: "Enter your name." })
  .trim()
  .min(1, "Enter your name.")
  .max(NAME_MAX, `Use at most ${NAME_MAX} characters.`);

export const SignupInput = z.object({ name, email, password: newPassword });
export type SignupInput = z.infer<typeof SignupInput>;

export const LoginInput = z.object({
  email,
  password: z.string({ message: "Enter your password." }).min(1, "Enter your password.").max(PASSWORD_MAX, "Wrong email or password."),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const ChangePasswordInput = z.object({
  currentPassword: z.string({ message: "Enter your current password." }).min(1, "Enter your current password.").max(PASSWORD_MAX),
  newPassword,
});

export const UpdateProfileInput = z.object({ name });

export type FieldErrors = Record<string, string>;

/** The first message per field, for inline errors. */
export function fieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/** A same-site path to go to after signing in; anything else falls back to /home. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/home";
  if (/^\/(login|signup)(\/|\?|$)/.test(next)) return "/home";
  return next;
}
