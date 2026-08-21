import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getOrgAssignmentContext,
  orgAutoKey,
  poolForWork,
  spreadOwnerId,
  type AssignmentContext,
} from "@/lib/operator-assignment";
import type { MarketKind } from "@/lib/lead-market";
import { postAgentAlert } from "@/lib/slack-alert";
import { deepLink } from "@/lib/slack";
import { callBriefHeadline, type CallBrief } from "@/lib/call-brief";

// Routing and notification for call tasks.
//
// Resolution walks the same ladder the rest of the app uses (explicit claim, then
// the org's sticky-random spread) but asks for the CALL side of the team, so phone
// work reaches someone who makes calls for this client rather than whoever owns
// the supplier's inbox.
//
// The call operator is the sole owner of the task (only they are ever assigned
// or claim it), but the Slack post @mentions both them and the email operator
// who sent the inquiry, for information: the caller wants to know who the
// supplier has already heard from, and the email side wants a heads-up their
// supplier is being called. Where a client has named no call operator the task
// stays unassigned and the post says so: a call routed to the email team is a
// ping nobody acts on, and it hides the fact that nobody is doing this client's
// phone work.

export interface OperatorTag {
  userId: string;
  name: string | null;
  email: string | null;
  slackUserId: string | null;
}

export interface CallRouting {
  // Who makes the call, and the only person tagged. Null when the client has
  // named no call operator.
  caller: OperatorTag | null;
  // Who owns this supplier's inbox. Context only, never tagged.
  emailOperator: OperatorTag | null;
}

// Per-run cache. Building an assignment context is several queries, and a sweep
// escalates many suppliers for the same org.
export class CallOperatorResolver {
  private ctxByOrg = new Map<string, AssignmentContext | null>();
  private orgById = new Map<string, { slug: string | null; name: string | null }>();
  private userById = new Map<string, OperatorTag>();
  private directory: Map<string, string> | null = null;

  constructor(private admin: SupabaseClient) {}

  private async assignmentContext(orgId: string): Promise<AssignmentContext | null> {
    if (!this.ctxByOrg.has(orgId)) {
      this.ctxByOrg.set(orgId, await getOrgAssignmentContext(this.admin, orgId).catch(() => null));
    }
    return this.ctxByOrg.get(orgId) ?? null;
  }

  private async org(orgId: string): Promise<{ slug: string | null; name: string | null }> {
    if (!this.orgById.has(orgId)) {
      const { data } = await this.admin.from("orgs").select("slug, name").eq("id", orgId).maybeSingle();
      this.orgById.set(orgId, { slug: (data as any)?.slug ?? null, name: (data as any)?.name ?? null });
    }
    return this.orgById.get(orgId)!;
  }

  async orgSlug(orgId: string): Promise<string | null> {
    return (await this.org(orgId)).slug;
  }

  async orgName(orgId: string): Promise<string | null> {
    return (await this.org(orgId)).name;
  }

  // Slack member ids come from the directory 0109 keeps refreshed, not from a
  // column on users: the same map every other agent mentions people through, and
  // the only one that covers operators who sign in with a personal address.
  private async slackIds(): Promise<Map<string, string>> {
    if (!this.directory) {
      const { data } = await this.admin.from("slack_directory").select("email, slack_user_id").eq("deleted", false);
      this.directory = new Map((data ?? []).map((r: any) => [String(r.email).toLowerCase(), r.slack_user_id]));
    }
    return this.directory;
  }

  private async operator(userId: string | null): Promise<OperatorTag | null> {
    if (!userId) return null;
    const cached = this.userById.get(userId);
    if (cached) return cached;
    const [{ data }, ids] = await Promise.all([
      this.admin.from("users").select("id, display_name, email").eq("id", userId).maybeSingle(),
      this.slackIds(),
    ]);
    const row = data as any;
    const email = (row?.email as string | null) ?? null;
    const tag: OperatorTag = {
      userId,
      name: row?.display_name ?? null,
      email,
      slackUserId: email ? ids.get(email.toLowerCase()) ?? null : null,
    };
    this.userById.set(userId, tag);
    return tag;
  }

  async route(opts: {
    orgId: string;
    assignedOperator: string | null;
    supplierId: string | null;
    supplierName: string | null;
    lane?: MarketKind | null;
  }): Promise<CallRouting> {
    const ctx = await this.assignmentContext(opts.orgId);
    if (!ctx) return { caller: null, emailOperator: null };

    // Key on the supplier the way every other surface does, so a supplier that
    // gets called twice reaches the same operator both times.
    const key = orgAutoKey(ctx, {
      supplierId: opts.supplierId,
      supplierName: opts.supplierName,
      leadId: opts.supplierId ?? opts.supplierName ?? "",
    });
    const spread = { lane: opts.lane ?? null, nameHint: opts.supplierName };

    // An explicit assignment on the source draft only holds for the call if that
    // person makes calls here; otherwise the call routes on its own, across the
    // call operators only. Empty pool = the client named none, and the task goes
    // out unowned rather than onto someone who doesn't dial.
    const callPool = poolForWork(ctx.pool, { type: "call", lane: opts.lane ?? null });
    const claimed =
      opts.assignedOperator && callPool.some((o) => o.id === opts.assignedOperator) ? opts.assignedOperator : null;
    const callerId = claimed ?? spreadOwnerId(ctx, key, { ...spread, workType: "call" });

    // Whoever the supplier has been emailing, for the caller's context: the draft's
    // own operator where it had one, else the desk owner the spread derives.
    const emailId = opts.assignedOperator ?? spreadOwnerId(ctx, key, { ...spread, workType: "email" });

    const [caller, emailOperator] = await Promise.all([this.operator(callerId), this.operator(emailId)]);
    return { caller, emailOperator };
  }
}

// Ping the ops channel with everything needed to make the call without opening
// anything, plus a link to the tab where the outcome gets logged. Fails soft:
// Slack being unconfigured must never block the escalation itself.
export async function notifyCallEscalation(args: {
  brief: CallBrief;
  routing: CallRouting;
  orgName: string | null;
  orgSlug: string | null;
  reason: string;
  // "agent" raises up to MAX_PER_RUN of these per sweep, so they roll into the
  // daily digest as one line each with no @-mention. "operator" is a button a
  // human just pressed and posts live, mentions included.
  origin?: "agent" | "operator";
}): Promise<boolean> {
  const { brief, routing, orgSlug } = args;
  const { caller } = routing;
  const named = (o: OperatorTag | null): string | null => (o ? o.name ?? o.email : null);
  // Skip it where the caller owns the inbox too, rather than printing one name twice.
  const emailOwner =
    routing.emailOperator && routing.emailOperator.userId !== caller?.userId ? named(routing.emailOperator) : null;

  const lines = [
    `:telephone_receiver: *Call ${brief.callStage}* ${args.orgName ? `for ${args.orgName}` : ""}`.trim(),
    callBriefHeadline(brief),
    `Why: ${args.reason}. ${brief.purpose}`,
    brief.phoneStatus === "missing"
      ? ":warning: No phone number on file. Find one, or add it on the call task so the next call is one click."
      : null,
    brief.materialNames.length ? `Materials: ${brief.materialNames.join(", ")}` : null,
    emailOwner ? `Emailed by ${emailOwner} (email operator, FYI only, this task stays with the caller)` : null,
    caller
      ? null
      : `:warning: ${args.orgName ?? "This client"} has no call operator named, so this call is unassigned. Name one under the client's operators to have calls routed.`,
    orgSlug ? `Open it: ${deepLink(`/work/orgs/${orgSlug}/calls`)}` : null,
  ].filter(Boolean) as string[];

  // Tag both for information; only the caller owns/claims the task. Whoever has
  // no Slack id gets their plain name printed instead, so the post still says
  // who they are even when the ping can't reach them.
  const callerName = named(caller);
  const emailName = emailOwner;
  const plainNames = [
    !caller?.slackUserId && callerName ? `*${callerName}*` : null,
    !routing.emailOperator?.slackUserId && emailName ? `*${emailName}*` : null,
  ].filter(Boolean) as string[];
  const text = [...plainNames, ...lines].join("\n");
  const mentionUserIds = [caller?.slackUserId, routing.emailOperator?.userId !== caller?.userId ? routing.emailOperator?.slackUserId : null].filter(
    Boolean
  ) as string[];
  if (args.origin === "agent") {
    const target = named(caller) ?? "unassigned";
    return postAgentAlert(text, {
      severity: "p2",
      // The call task, not the notification: the same lead re-raises as the
      // cadence advances, and that is one line per lead per day.
      key: `call_task:${brief.leadId ?? brief.threadId ?? brief.supplierName ?? "unknown"}:${brief.callStage}`,
      digestGroup: "Call tasks waiting",
      // Both names, because the digest renders the title and nothing else. The
      // body below says who emailed this supplier and the digest throws it
      // away, so the email operator learned nothing about their supplier being
      // called — which is half of AUTO-08 and the half that never posts live.
      title: `Call ${brief.callStage}: ${brief.supplierName ?? "a supplier"} → ${target}${
        emailOwner ? ` (emailed by ${emailOwner}, FYI)` : ""
      }${brief.phoneStatus === "missing" ? " (no phone on file)" : ""}`,
    }).catch(() => false);
  }
  return postAgentAlert(text, { mentionUserIds }).catch(() => false);
}
