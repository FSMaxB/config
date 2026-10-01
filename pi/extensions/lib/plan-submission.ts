import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export function registerPlanSubmission(
  events: ExtensionAPI["events"],
  service: PlanSubmissionService,
): () => void {
  // Discovery must finish synchronously; awaiting submission here would let
  // Pi's event-bus error logging swallow failures instead of failing Crit.
  return events.on(DISCOVERY_CHANNEL, (data) => {
    const request = data as DiscoveryRequest;
    request.services.push(service);
  });
}

export function canSubmitReviewedPlan(
  events: ExtensionAPI["events"],
  context: ExtensionContext,
): boolean {
  return discoverPlanSubmission(events)?.available(context) ?? false;
}

export async function submitReviewedPlan(
  events: ExtensionAPI["events"],
  params: PlanSubmissionParams,
  signal: AbortSignal | undefined,
  context: ExtensionContext,
): Promise<PlanSubmissionResult> {
  signal?.throwIfAborted();
  const service = discoverPlanSubmission(events);
  if (!service) throw new Error("Plan submission service is not available.");
  return await service.submit(params, signal, context);
}

function discoverPlanSubmission(
  events: ExtensionAPI["events"],
): PlanSubmissionService | undefined {
  const request: DiscoveryRequest = { services: [] };
  events.emit(DISCOVERY_CHANNEL, request);
  if (request.services.length > 1) {
    throw new Error("Multiple plan submission services are registered.");
  }
  return request.services[0];
}

const DISCOVERY_CHANNEL = "config:plan-submission:discover";

interface DiscoveryRequest {
  services: PlanSubmissionService[];
}

interface PlanSubmissionService {
  available: (context: ExtensionContext) => boolean;
  submit: (
    params: PlanSubmissionParams,
    signal: AbortSignal | undefined,
    context: ExtensionContext,
  ) => Promise<PlanSubmissionResult>;
}

export interface PlanSubmissionParams {
  path: string;
  suggestedModel?: string;
  suggestedModelReason?: string;
}

export type PlanSubmissionResult = AgentToolResult<{ path: string | null; outcome: string }>;
