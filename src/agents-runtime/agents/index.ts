// Discovery file — each embedded agent imports here and registers itself
// at module load. The runtime.ts re-imports this so the registry is hot
// in any process that needs it (cron handler, /api/agents/run, etc.).

import "./ping";
// import "./quote-revalidation"; // Phase G2
