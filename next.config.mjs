/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // playwright-core and Stagehand must stay out of the bundle: they reference
    // optional deps (chromium-bidi, kerberos) that webpack cannot resolve, and
    // failing to resolve them is a hard build error rather than a warning. We
    // only ever connect to a REMOTE Browserbase browser over CDP, so no browser
    // binary is needed here, just the client library loaded from node_modules.
    // On Next 14 this key is `experimental.serverComponentsExternalPackages`;
    // the Next 15 top-level `serverExternalPackages` is silently ignored here.
    serverComponentsExternalPackages: ["playwright-core", "@browserbasehq/stagehand", "@browserbasehq/sdk"],
    serverActions: { bodySizeLimit: "2mb" },
    // Live ops data (leads, drafts, agent runs) must be fresh on navigation.
    // Next's client Router Cache otherwise reuses a prefetched dynamic page for
    // ~30s, so clicking into Leads showed a stale snapshot until a hard refresh.
    // 0 = always refetch dynamic segments from the server on navigate.
    staleTimes: { dynamic: 0, static: 0 },
  },
  async redirects() {
    // The three triage queues were consolidated under /work/review/*.
    // Keep the old paths working for bookmarks and external links.
    return [
      { source: "/work/leads", destination: "/work/review/leads", permanent: false },
      { source: "/work/marketplace-findings", destination: "/work/review/marketplace", permanent: false },
      { source: "/work/cross-org", destination: "/work/review/drafts", permanent: false },
    ];
  },
};
export default nextConfig;
