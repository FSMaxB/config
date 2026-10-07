import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { analyze, parseReportArguments, renderReport } from "./analysis.ts";
import { fingerprintPayload } from "./fingerprint.ts";
import { cacheDebugDirectory, LogWriter, logFilePath, pruneLogs, readLog } from "./log-file.ts";
import { MarkerEvent, RECORD_VERSION, RequestTracker } from "./records.ts";

export default function (pi: ExtensionAPI) {
  if (process.env.PI_CACHE_DEBUG === "0") return;
  const directory = cacheDebugDirectory();
  const writer = new LogWriter(directory);
  const tracker = new RequestTracker((record) => writer.append(record));
  const errors = { last: undefined as string | undefined };

  // Every handler is wrapped: logging must never surface as an extension error in the request path.
  const safely = (action: () => void) => {
    try {
      action();
    } catch (error) {
      errors.last = error instanceof Error ? error.message : String(error);
    }
  };
  const marker = (context: ExtensionContext, event: MarkerEvent, detail?: string) =>
    writer.append({
      version: RECORD_VERSION,
      kind: "marker",
      sessionId: context.sessionManager.getSessionId(),
      at: new Date().toISOString(),
      event,
      ...(detail ? { detail } : {}),
    });

  pi.on("session_start", async (event, context) => {
    safely(() => marker(context, MarkerEvent.SessionStart, event.reason));
    void pruneLogs(directory).catch(() => undefined);
  });

  pi.on("before_provider_request", async (event, context) => {
    safely(() =>
      tracker.request({
        sessionId: context.sessionManager.getSessionId(),
        provider: context.model?.provider ?? "unknown",
        model: context.model?.id ?? "unknown",
        api: context.model?.api ?? "unknown",
        at: new Date(),
        payload: fingerprintPayload(event.payload),
      }),
    );
    return undefined;
  });

  pi.on("after_provider_response", async (event) => safely(() => tracker.response(event.status, event.headers)));

  pi.on("message_end", async (event, context) =>
    safely(() => {
      const { message } = event;
      if (message.role !== "assistant") return;
      tracker.assistantMessage({
        sessionId: context.sessionManager.getSessionId(),
        provider: message.provider,
        model: message.model,
        api: message.api,
        usage: message.usage,
        stopReason: message.stopReason,
        responseId: message.responseId,
        at: new Date(),
      });
    }),
  );

  pi.on("session_compact", async (_event, context) => safely(() => marker(context, MarkerEvent.Compaction)));
  pi.on("model_select", async (event, context) =>
    safely(() => marker(context, MarkerEvent.ModelSelect, `${event.model.provider}/${event.model.id}`)),
  );

  pi.on("session_shutdown", async () => {
    safely(() => tracker.shutdown());
    await writer.flush();
  });

  pi.registerCommand("cache-debug", {
    description: "Show the prompt-cache report for this session or another session id (--all lists every request)",
    handler: async (args, context) => {
      await writer.flush();
      const { verbosity, target } = parseReportArguments(args.trim().split(/\s+/).filter(Boolean));
      const sessionId = target ?? context.sessionManager.getSessionId();
      const report = renderReport(analyze(await readLog(logFilePath(directory, sessionId))), verbosity);
      const problems = [writer.lastError, errors.last].filter(Boolean).map((message) => `Logging error: ${message}`);
      await context.ui.editor(`Cache debug: ${sessionId}`, [...problems, report].join("\n"));
    },
  });
}
