// CLI: pull pricing by calling a Browserbase AGENT (native Agents API).
//   node pull-bbagent.mjs --url <url> --material "..." [--supplier "..."] [--agent-id <id>]
// Uses your reusable Browserbase Agent (--agent-id or BROWSERBASE_AGENT_ID). The
// Agent's own systemPrompt + resultSchema drive behavior and structured output; we
// pass the target as %variables% and print the mapped marketplace_pull JSON.
import { runAgent, toMarketplacePull, listAgents } from "./src/bbagent.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}

if (process.argv.includes("--list")) {
  const agents = await listAgents();
  console.log(JSON.stringify(agents, null, 2));
  process.exit(0);
}

const url = arg("url");
const material = arg("material", "");
const supplier = arg("supplier", "");
const agentId = arg("agent-id", process.env.BROWSERBASE_AGENT_ID);
if (!url || !material) {
  console.error("usage: node pull-bbagent.mjs --url <url> --material '..' [--supplier '..'] [--agent-id <id>]");
  process.exit(1);
}

// The task references per-run variables; the Agent's systemPrompt says how to use them.
const task = `Find the list/wholesale price for the material %material% from supplier %supplier% starting at %url%. Capture every pack-size tier. Do not log in or submit any RFQ/contact form.`;

const run = await runAgent({
  agentId,
  task,
  variables: {
    material: { value: material, description: "the chemical/material to price" },
    supplier: { value: supplier || "(unknown)", description: "the supplier/vendor name" },
    url: { value: url, description: "the starting product/listing URL" },
  },
  onMessage: (m) => console.error(`[bbagent] ${m.event}${m.runId ? " run=" + m.runId : ""}${m.viewUrl ? " " + m.viewUrl : ""}`),
});

console.error(`[bbagent] status=${run.status} session=${run.viewUrl ?? "(none)"}`);
console.log(JSON.stringify(toMarketplacePull(run, { url }), null, 2));
