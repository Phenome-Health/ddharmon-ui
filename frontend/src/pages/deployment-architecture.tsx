import { Link } from "wouter";
import {
  ArrowRight,
  Bot,
  Cloud,
  Database,
  ExternalLink,
  Globe,
  Network,
  Server,
  ShieldCheck,
  Table2,
} from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PH } from "@/lib/links";
import { UnderReviewBanner } from "@/components/under-review-banner";

/** Inline external link, styled + with an icon (matches the Methods/Design pages' `A`). */
function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-0.5 text-ph-navy underline decoration-ph-navy/30 underline-offset-2 hover:decoration-ph-navy"
    >
      {children}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

/** One node in the request-flow diagram. `accent` marks the app itself (the thing this repo builds). */
function FlowNode({ icon, label, sub, accent }: { icon: ReactNode; label: string; sub?: string; accent?: boolean }) {
  return (
    <div
      className={`flex min-w-[7.5rem] flex-col items-center gap-1 rounded-md border px-3 py-2 text-center ${
        accent ? "border-ph-navy/40 bg-ph-navy/5" : "border-neutral-200 bg-white"
      }`}
    >
      <span className={accent ? "text-ph-navy" : "text-neutral-500"}>{icon}</span>
      <span className="text-xs font-medium leading-tight text-ph-ink">{label}</span>
      {sub && <span className="text-[10px] leading-tight text-neutral-400">{sub}</span>}
    </div>
  );
}

function Arrow() {
  return <ArrowRight className="h-4 w-4 shrink-0 text-neutral-300" aria-hidden />;
}

/** A service section: what / why / where config lives / failure mode. */
function ServiceCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="text-ph-navy">{icon}</span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm leading-relaxed text-neutral-600">{children}</CardContent>
    </Card>
  );
}

/** The "fails:" line pattern — a muted footnote inside a service card. */
function Fails({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 border-t border-border pt-1.5 text-xs text-muted-foreground">
      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
      <span>
        <span className="font-medium text-neutral-600">Fails:</span> {children}
      </span>
    </p>
  );
}

export default function DeploymentArchitecturePage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-ph-ink">
          <Network className="h-6 w-6 text-ph-navy" /> Deployment architecture
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          How the pieces of the live app connect — the request path, the two channels, and each third-party
          service (what it does, why it's here, and how it fails). The public overview; the full narrative also
          lives in the repo as{" "}
          <A href={`${PH.ddharmonUi}/blob/main/docs/deployment_architecture.md`}>deployment_architecture.md</A>.
        </p>
      </div>

      <UnderReviewBanner />

      {/* Two repos, one app. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4 text-ph-navy" /> Two repos, one app
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm leading-relaxed text-neutral-600">
          <p>
            <span className="font-medium text-neutral-700">ddharmon</span> is the core harmonization library
            (published to PyPI). <span className="font-medium text-neutral-700">ddharmon-ui</span> is the web
            app — a FastAPI backend + a built React SPA — that runs it, depending on the core through a version
            pin. The app runs as a single small VM: nginx terminates TLS and reverse-proxies{" "}
            <span className="font-medium text-neutral-700">one</span> uvicorn worker serving both the JSON API
            and the SPA. LLM calls are <span className="font-medium text-neutral-700">BYOK</span> — each user
            brings their own provider key at runtime; the server holds none.
          </p>
        </CardContent>
      </Card>

      {/* Request-flow diagram (hand-drawn; the repo doc has the mermaid source). */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Request flow</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <div className="flex min-w-max flex-col gap-3">
              <div className="flex items-center gap-2">
                <FlowNode icon={<Globe className="h-4 w-4" />} label="Browser" sub="React SPA" />
                <Arrow />
                <FlowNode icon={<Globe className="h-4 w-4" />} label="DNS" sub="registrar" />
                <Arrow />
                <FlowNode icon={<Cloud className="h-4 w-4" />} label="nginx" sub="TLS + proxy" />
                <Arrow />
                <FlowNode icon={<Server className="h-4 w-4" />} label="FastAPI + SPA" sub="uvicorn · 1 worker" accent />
              </div>
              <div className="flex flex-wrap items-stretch gap-2 border-l-2 border-dashed border-neutral-200 pl-3">
                <span className="self-center text-[10px] uppercase tracking-wide text-neutral-400">the app talks to →</span>
                <FlowNode icon={<ShieldCheck className="h-4 w-4" />} label="Clerk" sub="verify JWT · JWKS" />
                <FlowNode icon={<Bot className="h-4 w-4" />} label="LLM providers" sub="BYOK · per request" />
                <FlowNode icon={<Database className="h-4 w-4" />} label="SQLite jobs.db" sub="durable history" />
                <FlowNode icon={<Database className="h-4 w-4" />} label="CDE catalog" sub="on-disk TSV" />
              </div>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-neutral-500">
            Sign-in happens in the browser via Clerk's JS SDK; the backend is stateless and only{" "}
            <span className="font-medium text-neutral-600">verifies</span> the resulting JWT against Clerk's
            JWKS. Progress streams over Server-Sent Events (nginx runs <code className="rounded bg-muted px-1 font-mono text-[11px]">proxy_buffering off</code> on the API path). A
            LiteLLM proxy gateway is planned to normalize multi-provider routing + BYOK virtual keys.
          </p>
        </CardContent>
      </Card>

      {/* Channels. */}
      <div>
        <h2 className="mb-2 flex items-center gap-2 text-lg font-semibold text-ph-ink">
          <Table2 className="h-5 w-5 text-ph-navy" /> Channels
        </h2>
        <p className="mb-3 text-sm text-neutral-500">
          Two fully isolated instances on the one VM (own systemd unit, port, vhost, and <code className="rounded bg-muted px-1 font-mono text-[11px]">.env</code>). A dev deploy
          never touches prod; dev is the pre-release gate. Promotion is one-directional: validate on dev →
          publish core to PyPI → repin + deploy prod.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-sm">
                Prod <Badge variant="neutral" className="text-[10px]">PyPI core</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-xs text-neutral-600">
              <p>The real tool. Core pinned to the stable PyPI release.</p>
              <p className="text-neutral-500">Clerk SSO + guest demo mode.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-sm">
                Dev <Badge variant="neutral" className="text-[10px]">git-ref core</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-xs text-neutral-600">
              <p>Staging. Core pinned to an unreleased git ref for pre-PyPI validation.</p>
              <p className="text-neutral-500">Clerk SSO, org-domain gated (no guest).</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-sm">
                Static preview <Badge variant="neutral" className="text-[10px]">no backend</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-xs text-neutral-600">
              <p>Client-side replay of committed demo fixtures (Netlify).</p>
              <p className="text-neutral-500">No server, no keys — marketing/demo.</p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Services. */}
      <div>
        <h2 className="mb-3 text-lg font-semibold text-ph-ink">Services</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <ServiceCard icon={<Cloud className="h-4 w-4" />} title="Compute — cloud VM">
            <p>A single Linux VM (AWS Lightsail) hosts both channels.</p>
            <p className="text-neutral-500">
              Chosen for simplicity: a low-traffic tool that must run one worker (the in-memory job registry +
              SSE rule out multi-worker / autoscale).
            </p>
            <Fails>VM or unit down → 502; systemd (Restart=always) respawns a crashed worker.</Fails>
          </ServiceCard>

          <ServiceCard icon={<Cloud className="h-4 w-4" />} title="nginx + certbot (TLS)">
            <p>Terminates HTTPS, reverse-proxies uvicorn, serves the SPA at <code className="rounded bg-muted px-1 font-mono text-[11px]">/</code>. certbot auto-renews Let's Encrypt certs.</p>
            <Fails>cert lapse → TLS errors (auto-renew guards this); vhost misconfig → 502.</Fails>
          </ServiceCard>

          <ServiceCard icon={<Server className="h-4 w-4" />} title="FastAPI app (uvicorn)">
            <p><code className="rounded bg-muted px-1 font-mono text-[11px]">backend.app:app</code> — the JSON API + static SPA. One worker only (more splits the in-memory store + breaks SSE).</p>
            <p className="text-neutral-500">Config: a per-channel <code className="rounded bg-muted px-1 font-mono text-[11px]">.env</code> with Clerk vars and no LLM key (BYOK).</p>
            <Fails>worker dies → respawned; any in-flight run is flipped to error on reboot, uploads kept for a one-click re-run.</Fails>
          </ServiceCard>

          <ServiceCard icon={<ShieldCheck className="h-4 w-4" />} title="Clerk — authentication">
            <p>SSO (session JWT) + a guest demo mode (prod). The backend verifies the Bearer JWT against Clerk's JWKS (pyjwt); Google sign-in is a Clerk social connection.</p>
            <p className="text-neutral-500">Config: the publishable key is baked into the frontend build; the issuer + optional org-domain guard live in the backend <code className="rounded bg-muted px-1 font-mono text-[11px]">.env</code>.</p>
            <Fails>a build missing the publishable key turns the client gate off (no token) while the backend stays gated → every API call 401s and the model catalog comes back empty.</Fails>
          </ServiceCard>

          <ServiceCard icon={<Globe className="h-4 w-4" />} title="Domain / DNS">
            <p>The apex domain and the dev subdomain resolve to the VM (registrar-managed DNS).</p>
            <Fails>DNS misconfig → unreachable even while the app is healthy.</Fails>
          </ServiceCard>

          <ServiceCard icon={<Bot className="h-4 w-4" />} title="LLM providers — BYOK">
            <p>Every run uses the user's provider key, passed as a transport-only header per request — never stored or logged. A LiteLLM proxy gateway is planned.</p>
            <Fails>a bad user key errors only that run — no server-side blast radius.</Fails>
          </ServiceCard>

          <ServiceCard icon={<Database className="h-4 w-4" />} title="Persistence & assets">
            <p>
              <span className="font-medium text-neutral-700">Run history</span> — a SQLite <code className="rounded bg-muted px-1 font-mono text-[11px]">jobs.db</code>; signed-in
              users' completed runs are written through and survive a pull + restart (only a fresh clone or
              deleting the DB wipes them). A restart only interrupts in-flight runs.
            </p>
            <p>
              <span className="font-medium text-neutral-700">CDE catalog</span> — a large TSV kept on the box
              (gitignored); a run with a non-empty CDE set needs it present. Demos re-seed on boot; guest runs
              are ephemeral.
            </p>
          </ServiceCard>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3">
        <p className="text-sm text-neutral-600">
          The full narrative (with the mermaid diagram source) lives in the ddharmon-ui repo.
        </p>
        <A href={`${PH.ddharmonUi}/blob/main/docs/deployment_architecture.md`}>
          docs/deployment_architecture.md <ArrowRight className="h-4 w-4" />
        </A>
      </div>
    </div>
  );
}
