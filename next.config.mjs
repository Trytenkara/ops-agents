/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { serverActions: { bodySizeLimit: "2mb" } },
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
