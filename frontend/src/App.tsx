import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Router, Switch } from "wouter";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/auth";
import { AppShell } from "@/components/AppShell";
import LandingPage from "@/pages/landing";
import HomePage from "@/pages/home";
import DashboardPage from "@/pages/dashboard";
import WorkbenchPage from "@/pages/workbench";
import AnalysisIdeasPage from "@/pages/analysis-ideas";
import CompositePage from "@/pages/composite";
import JobsPage from "@/pages/jobs";
import GuidePage from "@/pages/guide";
import MethodsPage from "@/pages/methods";
import BenchmarksPage from "@/pages/benchmarks";
import DesignChoicesPage from "@/pages/design-choices";
import DemoPage from "@/pages/demo";
import RelatedWorkPage from "@/pages/related-work";
import PhenomeHealthPage from "@/pages/phenome-health";
import RoadmapPage from "@/pages/roadmap";
import DeploymentArchitecturePage from "@/pages/deployment-architecture";
import PreviewRestructurePage from "@/pages/preview-restructure";
import PreviewPayoffPage from "@/pages/preview-payoff";
import PreviewCompositePage from "@/pages/preview-composite";
import PreviewReproducibilityPage from "@/pages/preview-reproducibility";
import PreviewKnowledgeGraphPage from "@/pages/preview-knowledge-graph";
// The staged review flow: one page file per gate, so no later screen plan has to touch this router.
// The file boundaries are fixed HERE, once, and each is owned by exactly one later plan.
import SetupPage from "@/pages/run/setup";
import Gate0Page from "@/pages/run/gate0";
import Gate1Page from "@/pages/run/gate1";
import Gate2Page from "@/pages/run/gate2";
import Gate3Page from "@/pages/run/gate3";
import Gate4Page from "@/pages/run/gate4";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

// Serve-path base (e.g. "/ddharmon-preview" on GitHub Pages); empty at root. Vite's BASE_URL carries it.
const ROUTER_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Router base={ROUTER_BASE}>
          <AppShell>
            <Switch>
            <Route path="/" component={LandingPage} />
            <Route path="/new" component={HomePage} />
            <Route path="/guide" component={GuidePage} />
            <Route path="/methods" component={MethodsPage} />
            <Route path="/benchmarks" component={BenchmarksPage} />
            <Route path="/design" component={DesignChoicesPage} />
            <Route path="/demo" component={DemoPage} />
            <Route path="/related" component={RelatedWorkPage} />
            <Route path="/roadmap" component={RoadmapPage} />
            <Route path="/architecture" component={DeploymentArchitecturePage} />
            <Route path="/preview/restructure" component={PreviewRestructurePage} />
            <Route path="/preview/payoff" component={PreviewPayoffPage} />
            <Route path="/preview/composite" component={PreviewCompositePage} />
            <Route path="/preview/reproducibility" component={PreviewReproducibilityPage} />
            <Route path="/preview/knowledge-graph" component={PreviewKnowledgeGraphPage} />
            <Route path="/phenome" component={PhenomeHealthPage} />
            <Route path="/run/:jobId/setup" component={SetupPage} />
            <Route path="/run/:jobId/gate0" component={Gate0Page} />
            <Route path="/run/:jobId/gate1" component={Gate1Page} />
            <Route path="/run/:jobId/gate2" component={Gate2Page} />
            <Route path="/run/:jobId/gate3" component={Gate3Page} />
            <Route path="/run/:jobId/gate4" component={Gate4Page} />
            <Route path="/job/:jobId/workbench" component={WorkbenchPage} />
            <Route path="/job/:jobId/analysis" component={AnalysisIdeasPage} />
            <Route path="/job/:jobId/composite" component={CompositePage} />
            <Route path="/job/:jobId" component={DashboardPage} />
            <Route path="/jobs" component={JobsPage} />
            <Route>
              <div className="p-8 text-on-field-muted">404 — page not found</div>
            </Route>
            </Switch>
          </AppShell>
        </Router>
        <Toaster />
      </TooltipProvider>
      </QueryClientProvider>
    </AuthProvider>
  );
}
