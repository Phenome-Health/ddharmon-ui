// Clerk SSO for the ddharmon-ui SPA (mirrors biomapper-ui's @clerk/react pattern, minus the Express
// proxy: we authorize the FastAPI backend with a Bearer JWT, not a session cookie).
//
// Gated on VITE_CLERK_PUBLISHABLE_KEY: with no key — the static/marketing build and local dev — this is
// a transparent pass-through, so those paths keep working with zero auth setup. The live deploy sets the
// key and shows a sign-in wall. That wall also offers a "try the demo without signing in" GUEST mode:
// guests browse the whole site + run the precomputed demo, but can't upload or run their own cohorts
// (the New-run + Runs pages show a sign-in CTA, and the backend gates every non-demo endpoint anyway).
//
// A LOCKED deployment (the PH-only dev channel, dev.ddharmon.io) builds with VITE_ALLOW_GUEST="false" to
// remove the guest bypass entirely, so sign-in is mandatory. Combined with a Clerk instance that admits only
// @phenomehealth.org Google accounts AND the backend's DDHARMON_ALLOWED_EMAIL_DOMAINS domain guard, the
// channel is PH-only on every layer (UI, Clerk, API). Prod leaves the flag unset and keeps guest demo mode.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ClerkProvider, SignIn, useAuth, useUser } from "@clerk/react";
import { AUTH_ENABLED, setLastToken, setTokenGetter } from "@/lib/api";

const PUB_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
// Guest "try the demo" bypass is allowed by default; only the explicit string "false" disables it (so an
// unset var — prod, local — keeps the current behavior). Build-time, matching the publishable-key gate.
const ALLOW_GUEST = import.meta.env.VITE_ALLOW_GUEST !== "false";

// Re-export so components can import the gate flag from "@/auth" without reaching into the api client.
export { AUTH_ENABLED };

interface AuthState {
  isAuthed: boolean; // a real signed-in Clerk session
  isGuest: boolean; // browsing via "try the demo" (no token; demo + read-only only)
  exitGuest: () => void; // leave guest mode -> show the sign-in wall
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
  const { isLoaded, isSignedIn } = useUser();
  const [guest, setGuest] = useState(false);

  if (!isLoaded) {
    return <div className="flex h-screen items-center justify-center text-sm text-neutral-500">Loading…</div>;
  }
  if (isSignedIn) {
    return (
      <AuthContext.Provider value={{ isAuthed: true, isGuest: false, exitGuest: () => {} }}>
        <TokenBridge />
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
