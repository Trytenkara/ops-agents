import type { SupabaseClient } from "@supabase/supabase-js";
import { getOrgAssignmentContext, resolveOperatorId, type AssignmentContext } from "@/lib/operator-assignment";
import { postAgentAlert } from "@/lib/slack-alert";
import { deepLink } from "@/lib/slack";
import { callBriefHeadline, type CallBrief } from "@/lib/call-brief";

// Routing and notification for calling escalations.
//
// A call task with nobody's name on it is a task nobody does, so an escalation
// must land on a person even when the draft it came from was never assigned.
// Resolution walks the same ladder the rest of the app uses (explicit claim,
// then the org's sticky-random spread, then the org's default operator) so the
// supplier keeps one point of contact across email and phone.

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
  private defaultByOrg = new Map<string, string | null>();
  private orgById = new Map<string, { slug: string | null; name: string | null }>();
  private userById = new Map<string, OperatorTag>();

  constructor(private admin: SupabaseClient) {}

  private async assignmentContext(orgId: string): Promise<AssignmentContext | null> {
    if (!this.ctxByOrg.has(orgId)) {
      this.ctxByOrg.set(orgId, await getOrgAssignmentContext(this.admin, orgId).catch(() => null));
    }
    return this.ctxByOrg.get(orgId) ?? null;
  }

  private async defaultOperator(orgId: string): Promise<string | null> {
    if (!this.defaultByOrg.has(orgId)) {
      const { data } = await this.admin
        .from("org_default_operators")
        .select("primary_user_id, backup_user_id, primary_user:users!org_default_operators_primary_user_id_fkey(status)")
        .eq("org_id", orgId)
        .maybeSingle();
      const row = data as any;
      const ooo = row?.primary_user?.status === "out_of_office";
      this.defaultByOrg.set(orgId, row ? (ooo ? row.backup_user_id ?? row.primary_user_id : row.primary_user_id) ?? null : null);
    }
    return this.defaultByOrg.get(orgId) ?? null;
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

  async tag(orgId: string, opts: { assignedOperator: string | null; supplierId: string | null; supplierName: string | null }): Promise<OperatorTag> {
    let userId = opts.assignedOperator;
    if (!userId) {
      const ctx = await this.assignmentContext(orgId);
      userId = ctx ? resolveOperatorId(ctx, opts.supplierId, null, opts.supplierName) : null;
    }
    if (!userId) userId = await this.defaultOperator(orgId);
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
  silence: string;
}): Promise<boolean> {
  const { brief, operator, orgSlug } = args;
  const lines = [
    `:telephone_receiver: *Calling escalation* ${args.orgName ? `for ${args.orgName}` : ""}`.trim(),
    callBriefHeadline(brief),
    `Why: ${args.silence}. ${brief.purpose}`,
    brief.phoneStatus === "missing"
      ? ":warning: No phone number on file. Find one, or add it on the escalation so the next call is one click."
      : null,
    brief.materialNames.length ? `Materials: ${brief.materialNames.join(", ")}` : null,
    orgSlug ? `Open it: ${deepLink(`/work/orgs/${orgSlug}/threads?tab=escalations`)}` : null,
  ].filter(Boolean) as string[];

  const owner = operator.name ?? operator.email;
  const text = operator.slackUserId ? lines.join("\n") : [owner ? `*${owner}*` : null, ...lines].filter(Boolean).join("\n");
  return postAgentAlert(text, { mentionUserId: operator.slackUserId ?? undefined }).catch(() => false);
}
