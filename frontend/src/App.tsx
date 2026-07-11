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
import JobsPage from "@/pages/jobs";
import GuidePage from "@/pages/guide";
import MethodsPage from "@/pages/methods";
import BenchmarksPage from "@/pages/benchmarks";
import DesignChoicesPage from "@/pages/design-choices";
import DemoPage from "@/pages/demo";
import RelatedWorkPage from "@/pages/related-work";
import PhenomeHealthPage from "@/pages/phenome-health";

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
            <Route path="/phenome" component={PhenomeHealthPage} />
            <Route path="/job/:jobId/workbench" component={WorkbenchPage} />
            <Route path="/job/:jobId" component={DashboardPage} />
            <Route path="/jobs" component={JobsPage} />
            <Route>
              <div className="p-8 text-neutral-500">404 — page not found</div>
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
