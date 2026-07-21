// Clerk SSO for the ddharmon-ui SPA (mirrors biomapper-ui's @clerk/react pattern, minus the Express
// proxy: we authorize the FastAPI backend with a Bearer JWT, not a session cookie).
//
// Gated on VITE_CLERK_PUBLISHABLE_KEY: with no key — the static/marketing build and local dev — this is
// a transparent pass-through, so those paths keep working with zero auth setup. The live deploy sets the
// key and shows a sign-in wall. That wall also offers a "try the demo without signing in" GUEST mode:
// guests browse the whole site + run the precomputed demo, but can't upload or run their own cohorts
// (the New-run + Runs pages show a sign-in CTA, and the backend gates every non-demo endpoint anyway).
//
// Two access tiers keyed on the signed-in email domain (VITE_FULL_ACCESS_DOMAINS): a full-access domain
// (e.g. phenomehealth.org) -> the complete run-capable UI; any other signed-in user -> the SAME read-only
// demo path as a guest (verified identity, no runs). Empty/unset (prod, local) -> every signed-in user is
// full, unchanged. The dev channel shares a demo with collaborators while keeping runs PH-only, and is
// STRICTER than prod: it builds with VITE_ALLOW_GUEST="false" (no anonymous bypass), so even the read-only
// demo needs an authenticated identity — Clerk's passwordless email-code lets a collaborator sign in with
// just their email and land read-only, while only @phenomehealth.org sees full. The backend's
// DDHARMON_ALLOWED_EMAIL_DOMAINS guard is the real run-gate; the frontend tier is UX only.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ClerkProvider, SignIn, useAuth, useUser } from "@clerk/react";
import { AUTH_ENABLED, setLastToken, setTokenGetter } from "@/lib/api";

const PUB_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
// Guest "try the demo" bypass is allowed by default; only the explicit string "false" disables it (so an
// unset var — prod, local — keeps the current behavior). Build-time, matching the publishable-key gate.
const ALLOW_GUEST = import.meta.env.VITE_ALLOW_GUEST !== "false";
// Email domains that get FULL (run-capable) access; every other signed-in user is downgraded to the
// read-only demo. Empty/unset (prod, local) -> every signed-in user is full (unchanged). Build-time.
const FULL_ACCESS_DOMAINS = ((import.meta.env.VITE_FULL_ACCESS_DOMAINS as string | undefined) ?? "")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);
// Optional caption under the sign-in box (dev channel tells collaborators to use their email for a code).
const SIGNIN_NOTE = import.meta.env.VITE_SIGNIN_NOTE as string | undefined;

// Re-export so components can import the gate flag from "@/auth" without reaching into the api client.
export { AUTH_ENABLED };

interface AuthState {
  isAuthed: boolean; // a real signed-in Clerk session with FULL access
  isGuest: boolean; // read-only demo — anonymous guest OR a signed-in non-full-access user (no runs)
  email?: string; // present when there IS a Clerk session (full or read-only); undefined for anonymous guests
  exitGuest: () => void; // anonymous guest -> back to the wall; signed-in read-only -> sign out
}
const AuthContext = createContext<AuthState>({ isAuthed: true, isGuest: false, exitGuest: () => {} });

/** UI-facing auth state. When the gate is off (static/dev) callers see `{ isAuthed: true, isGuest: false }`
 *  so the whole app is open, exactly as before. */
export const useAuthState = () => useContext(AuthContext);

/** Bridges Clerk's session token to the (non-React) api client: an async getter for fetch/SSE calls, plus
 *  a periodically-refreshed cached token for the synchronous export-download hrefs. */
function TokenBridge() {
  const { getToken } = useAuth();
  useEffect(() => {
    setTokenGetter(() => getToken());
    let alive = true;
    const refresh = () => void getToken().then((t) => alive && setLastToken(t)).catch(() => {});
    refresh();
    const id = setInterval(refresh, 30_000); // Clerk session tokens are short-lived (~60s); stay ahead of expiry
    return () => {
      alive = false;
      clearInterval(id);
      setTokenGetter(null);
      setLastToken(null);
    };
  }, [getToken]);
  return null;
}

function SignInWall({ onGuest }: { onGuest?: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-50 p-6">
      <SignIn />
      {/* Optional collaborator hint (dev channel): sign in with an email for a one-time code. Unset on
          prod → nothing renders. */}
      {SIGNIN_NOTE && <p className="max-w-sm text-center text-sm text-neutral-600">{SIGNIN_NOTE}</p>}
      {/* Guest bypass — omitted on a locked (PH-only) deployment where sign-in is mandatory. */}
      {onGuest && (
        <button
          type="button"
          onClick={onGuest}
          className="text-sm font-medium text-ph-navy underline underline-offset-4 transition-colors hover:text-ph-ink"
        >
          Or explore the demo without signing in →
        </button>
      )}
    </div>
  );
}

function Gate({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const { signOut } = useAuth();
  const [guest, setGuest] = useState(false);

  if (!isLoaded) {
    return <div className="flex h-screen items-center justify-center text-sm text-neutral-500">Loading…</div>;
  }
  if (isSignedIn) {
    const email = user?.primaryEmailAddress?.emailAddress ?? undefined;
    const domain = email?.split("@")[1]?.toLowerCase();
    const fullAccess = FULL_ACCESS_DOMAINS.length === 0 || (!!domain && FULL_ACCESS_DOMAINS.includes(domain));
    if (fullAccess) {
      return (
        <AuthContext.Provider value={{ isAuthed: true, isGuest: false, email, exitGuest: () => {} }}>
          <TokenBridge />
          {children}
        </AuthContext.Provider>
      );
    }
    // Signed in but not a full-access domain -> read-only demo (verified identity, but no real runs).
    // No TokenBridge: the demo endpoints are public, and the backend domain guard would 403 real calls
    // anyway — so we render exactly the guest read-only surface.
    return (
      <AuthContext.Provider value={{ isAuthed: false, isGuest: true, email, exitGuest: () => void signOut() }}>
        {children}
      </AuthContext.Provider>
    );
  }
  if (guest && ALLOW_GUEST) {
    return (
      <AuthContext.Provider value={{ isAuthed: false, isGuest: true, exitGuest: () => setGuest(false) }}>
        {children}
      </AuthContext.Provider>
    );
  }
  // On a locked deployment (ALLOW_GUEST=false) the wall offers no guest bypass — sign-in is required.
  return <SignInWall onGuest={ALLOW_GUEST ? () => setGuest(true) : undefined} />;
}

/** Wraps the app in Clerk + a sign-in gate (with guest bypass) when AUTH_ENABLED; a transparent
 *  pass-through (fully open) otherwise. */
export function AuthProvider({ children }: { children: ReactNode }) {
  if (!AUTH_ENABLED) return <>{children}</>;
  return (
    <ClerkProvider publishableKey={PUB_KEY as string} afterSignOutUrl="/">
      <Gate>{children}</Gate>
    </ClerkProvider>
  );
}
