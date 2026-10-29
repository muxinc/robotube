function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Caption Directive response object.");
  return value as Record<string, unknown>;
}
function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid Caption Directive ${field}.`);
  return value;
}
export function parseCaptionDirectiveRunId(payload: unknown): string {
  // v1 returns the run identifier as `id`; v0 Directives returned `run_id`.
  const run = record(record(payload).data);
  return identifier(run.id ?? run.run_id, "run_id");
}

type DirectiveNode = { reference_id: string; status: string; job_id?: string; reason?: string };
export function parseCaptionDirectiveRun(payload: unknown): { status: string; node_states: DirectiveNode[] } {
  const run = record(record(payload).data);
  if (typeof run.status !== "string" || !["pending", "dispatching", "running", "waiting", "completed", "partial", "errored"].includes(run.status) || !Array.isArray(run.node_states)) {
    throw new Error("Invalid Caption Directive run status or node_states.");
  }
  const seen = new Set<string>();
  const nodes = run.node_states.map(value => {
    const node = record(value);
    const reference_id = identifier(node.reference_id, "reference_id");
    if (seen.has(reference_id)) throw new Error("Invalid duplicate Caption Directive reference_id.");
    seen.add(reference_id);
    if (typeof node.status !== "string" || !["dispatched", "failed", "waiting_for_resources", "waiting_for_source_bindings", "waiting_for_source_workflow"].includes(node.status)) throw new Error("Invalid Caption Directive node status.");
    const result: DirectiveNode = { reference_id, status: node.status };
    if (node.status === "dispatched") result.job_id = identifier(node.job_id, "job_id");
    if (node.status === "failed") result.reason = identifier(node.reason, "failure reason");
    return result;
  });
  return { status: run.status, node_states: nodes };
}
