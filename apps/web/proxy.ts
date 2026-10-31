import { type NextRequest, NextResponse } from "next/server";
import { authRequired, SESSION_COOKIE, userForToken } from "./server/auth/session";

// The sign-in gate (Next 16 proxy, formerly middleware; Node.js runtime). Signed-out visitors to an app
// page go to /login?next=<the page>. Public pages, shared answer permalinks (/r/*), the API, static files
// and /dev stay open. Pages that read per-user data must still check the session themselves.

/** App pages that need an account. /r/* is not here: shared answer links work without one. */
const GATED = [/^\/home$/, /^\/ask(\/|$)/, /^\/run(\/|$)/, /^\/briefs(\/|$)/, /^\/following(\/|$)/, /^\/screener(\/|$)/, /^\/d(\/|$)/, /^\/settings(\/|$)/];

export function isGatedPath(pathname: string): boolean {
  return GATED.some((re) => re.test(pathname));
}

export async function proxy(request: NextRequest) {
  if (!authRequired()) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  if (!isGatedPath(pathname)) return NextResponse.next();
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  let signedIn = false;
  if (token) {
    try {
      signedIn = (await userForToken(token)) !== null;
    } catch {
      // Database unreachable: the login page says so when the visitor tries to sign in.
      signedIn = false;
    }
  }
  if (signedIn) return NextResponse.next();
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = `?next=${encodeURIComponent(`${pathname}${search}`)}`;
  return NextResponse.redirect(login);
}

export const config = {
  // Page routes only: never the API, Next internals or files with an extension.
  matcher: ["/((?!api/|_next/|dev/|.*\\.[a-zA-Z0-9]+$).*)"],
};
