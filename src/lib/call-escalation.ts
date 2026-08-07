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
// A call task with nobody's name on it is a task nobody does, so it must land on
// a person even when the draft it came from was never assigned. Resolution walks
// the same ladder the rest of the app uses (explicit claim, then the org's
// sticky-random spread) but asks for the CALL side of the team and the supplier's
// own lane, so phone work reaches someone who makes calls for this client rather
// than whoever happens to own the supplier's inbox.
//
// Where a client has named no call operators, or none covering that lane, the
// spread falls back to the whole pool (see poolForWork): an unrouted call task is
// worse than one routed to an email operator.

export interface OperatorTag {
  userId: string | null;
  name: string | null;
  email: string | null;
  slackUserId: string | null;
}

// Per-run cache. Building an assignment context is several queries, and a sweep
// escalates many suppliers for the same org.
export class CallOperatorResolver {
  private ctxByOrg = new Map<string, AssignmentContext | null>();
  private orgById = new Map<string, { slug: string | null; name: string | null }>();
  private userById = new Map<string, OperatorTag>();

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

  async tag(opts: {
    orgId: string;
    assignedOperator: string | null;
    supplierId: string | null;
    supplierName: string | null;
    lane?: MarketKind | null;
  }): Promise<OperatorTag> {
    const { orgId } = opts;
    const ctx = await this.assignmentContext(orgId);
    // An explicit assignment on the source draft only holds if that person does
    // phone work here; otherwise the call routes on its own.
    const callPool = ctx ? poolForWork(ctx.pool, { type: "call", lane: opts.lane ?? null }) : [];
    let userId =
      opts.assignedOperator && callPool.some((o) => o.id === opts.assignedOperator) ? opts.assignedOperator : null;

    if (!userId && ctx) {
      // Key on the supplier the way every other surface does, so a supplier that
      // gets called twice reaches the same operator both times. spreadOwnerId
      // also covers the org that runs manual assignment: a phone task nobody owns
      // is a call nobody makes.
      userId = spreadOwnerId(
        ctx,
        orgAutoKey(ctx, {
          supplierId: opts.supplierId,
          supplierName: opts.supplierName,
          leadId: opts.supplierId ?? opts.supplierName ?? "",
        }),
        { lane: opts.lane ?? null, nameHint: opts.supplierName, workType: "call" }
      );
    }
    if (!userId) return { userId: null, name: null, email: null, slackUserId: null };

    const cached = this.userById.get(userId);
    if (cached) return cached;
    // slack_user_id arrives with 0105. Selecting it before the migration lands
    // would fail the whole row read and cost us the operator's name too, so the
    // mention is asked for separately and its absence just means no @mention.
    const [{ data }, { data: slack }] = await Promise.all([
      this.admin.from("users").select("id, display_name, email").eq("id", userId).maybeSingle(),
      this.admin.from("users").select("slack_user_id").eq("id", userId).maybeSingle(),
    ]);
    const row = data as any;
    const tag: OperatorTag = {
      userId,
      name: row?.display_name ?? null,
      email: row?.email ?? null,
      slackUserId: (slack as any)?.slack_user_id ?? null,
    };
    this.userById.set(userId, tag);
    return tag;
  }
}

// Ping the ops channel with everything needed to make the call without opening
// anything, plus a link to the tab where the outcome gets logged. Fails soft:
// Slack being unconfigured must never block the escalation itself.
export async function notifyCallEscalation(args: {
  brief: CallBrief;
  operator: OperatorTag;
  orgName: string | null;
  orgSlug: string | null;
  reason: string;
}): Promise<boolean> {
  const { brief, operator, orgSlug } = args;
  const lines = [
    `:telephone_receiver: *Call ${brief.callStage}* ${args.orgName ? `for ${args.orgName}` : ""}`.trim(),
    callBriefHeadline(brief),
    `Why: ${args.reason}. ${brief.purpose}`,
    brief.phoneStatus === "missing"
      ? ":warning: No phone number on file. Find one, or add it on the call task so the next call is one click."
      : null,
    brief.materialNames.length ? `Materials: ${brief.materialNames.join(", ")}` : null,
    orgSlug ? `Open it: ${deepLink(`/work/orgs/${orgSlug}/calls`)}` : null,
  ].filter(Boolean) as string[];

  const owner = operator.name ?? operator.email;
  const text = operator.slackUserId ? lines.join("\n") : [owner ? `*${owner}*` : null, ...lines].filter(Boolean).join("\n");
  return postAgentAlert(text, { mentionUserId: operator.slackUserId ?? undefined }).catch(() => false);
}
