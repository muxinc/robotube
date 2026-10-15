import { pathToFileURL } from "node:url";
import { buildCaptionDirectiveDefinition } from "../convex/captionDirectivesConfig.ts";

const API = "https://api.mux.com/robots/v0/directives";
const variants = [
  { envKey: "MUX_CAPTION_DIRECTIVE_WITHOUT_SPEAKERS_ID", includeSpeakers: false },
  { envKey: "MUX_CAPTION_DIRECTIVE_WITH_SPEAKERS_ID", includeSpeakers: true },
];

export function captionDirectivePlan() {
  return variants.map(({ envKey, includeSpeakers }) => ({
    envKey,
    definition: buildCaptionDirectiveDefinition({ includeSpeakers }),
  }));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function validateDirective(actual, expected) {
  if (!actual || typeof actual.id !== "string" || !/^drv_[A-Za-z0-9_-]+$/.test(actual.id)) {
    throw new Error("Mux returned an invalid Directive ID. Inspect the Dashboard before retrying.");
  }
  const config = Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]]));
  if (JSON.stringify(canonical(config)) !== JSON.stringify(canonical(expected))) {
    throw new Error(`Directive ${actual.id} does not match ${expected.name}. Do not reuse it; inspect its immutable configuration.`);
  }
  return actual.id;
}

export async function provisionCaptionDirectives({ create = false, env = process.env, fetchImpl = fetch, emit = console.log } = {}) {
  const plan = captionDirectivePlan();
  if (!create) return { mode: "dry-run", directives: plan };
  if (!env.MUX_TOKEN_ID || !env.MUX_TOKEN_SECRET) {
    throw new Error("Set MUX_TOKEN_ID and MUX_TOKEN_SECRET for the intended Mux environment. No changes made.");
  }
  const authorization = `Basic ${Buffer.from(`${env.MUX_TOKEN_ID}:${env.MUX_TOKEN_SECRET}`).toString("base64")}`;
  async function request(path, body) {
    const method = body === undefined ? "GET" : "POST";
    const unconfirmed = () => new Error(`Mux ${method} directives${path} could not be confirmed. ${method === "POST" ? "Creation may have succeeded" : "Earlier creations may have succeeded"}; inspect the Dashboard before retrying.`);
    let response;
    try {
      response = await fetchImpl(API + path, {
        method,
        headers: { Authorization: authorization, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw unconfirmed();
    }
    if (!response.ok) throw new Error(`Mux ${method} directives${path} failed (${response.status}). Inspect the Dashboard before retrying; earlier creations may have succeeded.`);
    let payload;
    try { payload = await response.json(); } catch { throw unconfirmed(); }
    if (!payload || !Object.hasOwn(payload, "data")) throw new Error("Mux response has no data. Inspect the Dashboard before retrying.");
    return payload.data;
  }

  const existing = [];
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error("Directive listing exceeds 100 pages. No Directives created.");
    const entries = await request(`?limit=25&page=${page}`);
    if (!Array.isArray(entries)) throw new Error("Mux Directive list is not an array. No Directives created.");
    existing.push(...entries);
    if (entries.length < 25) break;
  }
  const resolved = [];
  for (const { envKey, definition } of plan) {
    const matches = existing.filter((entry) => entry?.name === definition.name);
    if (matches.length > 1) throw new Error(`Multiple Directives named ${definition.name}. Resolve the ambiguity in the Dashboard.`);
    let data;
    if (matches.length) {
      const id = matches[0].id;
      if (typeof id !== "string" || !/^drv_[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid existing Directive ID.");
      data = await request(`/${id}`);
    } else {
      data = await request("", definition);
    }
    const id = validateDirective(data, definition);
    emit(`${envKey}=${id}`);
    resolved.push({ envKey, id, reused: matches.length === 1 });
  }
  return { mode: "created-or-reused", directives: resolved };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && !["--create", "--help"].includes(args[0]))) {
      throw new Error("Usage: node --experimental-strip-types scripts/provision-caption-directives.mjs [--create]");
    }
    if (args[0] === "--help") {
      console.log("Prints both Directive definitions without network access. --create creates or reuses matching definitions in the token's Mux environment; it never starts runs or configures Convex.");
    } else {
      const result = await provisionCaptionDirectives({ create: args[0] === "--create" });
      if (result.mode === "dry-run") console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Provisioning failed. Inspect the Dashboard before retrying.");
    process.exitCode = 1;
  }
}
