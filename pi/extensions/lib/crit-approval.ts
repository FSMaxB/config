export function isCritPlanApproved(stderr: string): boolean {
  // Crit 0.20.2 RunReviewClient (internal/daemon/client.go) emits this contract
  // on stderr, even in quiet mode; stdout is arbitrary user feedback.
  const markers = stderr.split(/\r?\n/).filter((line) => line.startsWith("approved:"));
  return markers.length === 1 && markers[0] === "approved: true";
}
