import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { ScrollToTop } from "./components/ScrollToTop";

import Index from "./pages/Index";
import { RadioPage } from "./pages/RadioPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage, SETUP_COMPLETE_KEY, getStoredName } from "./pages/SetupPage";
import { NIP19Page } from "./pages/NIP19Page";
import NotFound from "./pages/NotFound";

/** Guard: redirect to /setup if the user hasn't completed onboarding. */
function RequireSetup({ children }: { children: React.ReactNode }) {
  const done = localStorage.getItem(SETUP_COMPLETE_KEY) === 'true';
  if (!done) return <Navigate to="/setup" replace />;
  return <>{children}</>;
}

/** Redirect / to radio if setup is already done, else to setup. */
function HomeRedirect() {
  const host = window.location.hostname;
  const isTailscaleHost = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) || host.endsWith('.ts.net');
  const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches
    || ('standalone' in window.navigator && (window.navigator as Navigator & { standalone?: boolean }).standalone === true);
  if (isTailscaleHost || isStandalone) return <Navigate to="/remote?remote=1" replace />;

  const done = localStorage.getItem(SETUP_COMPLETE_KEY) === 'true';
  if (done) {
    const name = getStoredName();
    return <Navigate to={`/radio?name=${encodeURIComponent(name)}`} replace />;
  }
  return <Navigate to="/setup" replace />;
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <ScrollToTop />
      <Routes>
        {/* Root: redirect based on setup state */}
        <Route path="/" element={<HomeRedirect />} />

        {/* Onboarding — always accessible */}
        <Route path="/setup" element={<SetupPage />} />

        {/* Radio — requires setup */}
        <Route path="/radio" element={
          <RequireSetup><RadioPage /></RequireSetup>
        } />

        {/* Remote Pi cockpit — same WebPlayer UI, server/engine-backed playback */}
        <Route path="/remote" element={
          <RadioPage />
        } />

        {/* Settings — always accessible during session */}
        <Route path="/settings" element={<SettingsPage />} />

        {/* Legacy welcome page — redirect appropriately */}
        <Route path="/welcome" element={<Index />} />

        {/* NIP-19 route for npub1, note1, naddr1, nevent1, nprofile1 */}
        <Route path="/:nip19" element={<NIP19Page />} />

        {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
export default AppRouter;
