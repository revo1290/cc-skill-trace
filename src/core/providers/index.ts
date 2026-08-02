import type { ProviderId } from "../types.js";
import { claudeCodeProvider } from "./claude-code.js";
import { codexProvider } from "./codex.js";
import { copilotProvider } from "./copilot.js";
import type { Provider } from "./types.js";

export type { Provider, SkillDef, ProviderConfidence, ProviderHookInfo, ProviderSessionFile } from "./types.js";

/** All known providers, keyed by {@link ProviderId}, in default display order. */
export const PROVIDERS: Record<ProviderId, Provider> = {
  "claude-code": claudeCodeProvider,
  codex: codexProvider,
  copilot: copilotProvider,
};

export const ALL_PROVIDER_IDS: ProviderId[] = ["claude-code", "codex", "copilot"];

export function getProvider(id: ProviderId): Provider {
  return PROVIDERS[id];
}

/** Parse a `--provider` CLI flag value, throwing a user-facing error on an unknown id. */
export function resolveProviderId(value: string): ProviderId {
  if ((ALL_PROVIDER_IDS as string[]).includes(value)) return value as ProviderId;
  throw new Error(`Unknown provider "${value}". Supported: ${ALL_PROVIDER_IDS.join(", ")}`);
}
