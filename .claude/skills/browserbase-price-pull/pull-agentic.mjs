// CLI: AGENTIC price pull for a single marketplace listing.
//   node pull-agentic.mjs --url <url> [--supplier "..."] [--material "..."] [--max-steps 12]
// Unlike pull.mjs (passive read of the landing page), this drives the site like a
// person — closes popups, uses the on-site search, tries material-name variants,
// opens the matching product page — then extracts the price ladder. Built on
// Stagehand + Browserbase. Prints one JSON object to stdout; session URL to stderr.
import { agenticPull } from "./src/agentic.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}

const url = arg("url");
const supplier = arg("supplier", "");
const material = arg("material", "");
const maxSteps = Number(arg("max-steps", "15")) || 15;
if (!url) {
  console.error("usage: node pull-agentic.mjs --url <url> [--supplier ..] [--material ..] [--max-steps 12]");
  process.exit(1);
}

let n = 0;
const result = await agenticPull({
  url,
  supplier,
  material,
  maxSteps,
  onSession: ({ viewUrl }) => console.error(`live session — ${viewUrl}`),
  onStep: (s) => console.error(`  step ${++n}: [${s.type ?? s.step ?? ""}] ${s.action ?? ""}${s.url ? ` @ ${s.url}` : ""}`),
});

console.log(JSON.stringify(result, null, 2));
