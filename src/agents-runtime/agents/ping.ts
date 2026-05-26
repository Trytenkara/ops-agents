import { registerAgent } from "../registry";

// A no-op agent. Useful for verifying the embedded runtime end-to-end
// without burning LLM tokens or touching Missive.
registerAgent({
  slug: "ping",
  displayName: "Ping",
  description: "Runtime heartbeat. Writes a few events and exits cleanly.",
  async run(ctx) {
    await ctx.log("Heartbeat 1/3", { step: "heartbeat", data: { n: 1 } });
    await new Promise((r) => setTimeout(r, 300));
    await ctx.log("Heartbeat 2/3", { step: "heartbeat", data: { n: 2 } });
    await new Promise((r) => setTimeout(r, 300));
    await ctx.log("Heartbeat 3/3", { step: "heartbeat", data: { n: 3 } });

    ctx.setItemsProcessed(3);
    ctx.setSummary("Pinged 3 times. Runtime is alive.");
    ctx.setStatus("success");
  },
});
