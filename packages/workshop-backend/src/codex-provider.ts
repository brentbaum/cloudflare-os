import type { Model } from "@earendil-works/pi-ai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import type {
  AiChatAuthorInfo,
  CodexConnectionStatus,
  CodexModelConfig,
} from "@gadgets/workshop-shared/api";
import type {
  CodexRelayContract,
  CodexRelayStatus,
} from "@gadgets/workshop-shared/codex-relay";

/** Server-owned routing key for the deployment-wide v1 subscription. */
export const SHARED_CODEX_CONNECTION = "shared-v1";

/** Namespace that keeps subscription models distinct from API-key OpenAI models. */
export const CODEX_MODEL_PREFIX = "openai-codex/";

/** Upstream model IDs projected by the v1 provider, in fallback preference order. */
export const CODEX_MODEL_IDS = ["gpt-5.6-sol", "gpt-5.6-luna"] as const;

/** Upstream model ID recommended for lightweight title and summary work. */
export const CODEX_QUICK_MODEL_ID = "gpt-5.6-luna";

type CodexModelId = typeof CODEX_MODEL_IDS[number];
type CodexCatalogModel = Model<"openai-codex-responses">;
type CodexRelayService = Service & CodexRelayContract;

/** A projected profile and its non-secret, backend-generated routing configuration. */
export type ProjectedCodexModel = {
  profile: AiChatAuthorInfo;
  config: CodexModelConfig;
};

function relay(env: Cloudflare.Env): CodexRelayService | undefined {
  if (env.CODEX_SUBSCRIPTION_ENABLED !== "true") return undefined;
  return env.CODEX_RELAY;
}

/** Whether the deployment explicitly enabled the provider and supplied its private binding. */
export function isCodexConfigured(env: Cloudflare.Env): boolean {
  return relay(env) !== undefined;
}

/** Read the sanitized shared-connection state, returning disabled when the feature is inert. */
export function getCodexConnectionStatus(env: Cloudflare.Env): Promise<CodexConnectionStatus> {
  const binding = relay(env);
  return binding
    ? binding.status(SHARED_CODEX_CONNECTION)
    : Promise.resolve({ state: "disabled" });
}

/** Return the private relay binding only when the feature is explicitly enabled. */
export function getCodexRelay(env: Cloudflare.Env): CodexRelayService | undefined {
  return relay(env);
}

/** True only for a ready credential generation that may project models. */
export function isReadyCodexStatus(
  status: CodexConnectionStatus,
): status is Extract<CodexRelayStatus, { state: "ready" }> {
  return status.state === "ready";
}

/** Convert an upstream model ID to its stable selectable AgentOS ID. */
export function codexProfileId(modelId: string): string {
  return `${CODEX_MODEL_PREFIX}${modelId}`;
}

/** Whether an AgentOS model ID belongs to the shared Codex namespace. */
export function isCodexProfileId(modelId: string): boolean {
  return modelId.startsWith(CODEX_MODEL_PREFIX);
}

/** Return a pinned Pi catalog entry, failing on dependency drift rather than inventing metadata. */
export function codexCatalogModel(modelId: string): CodexCatalogModel {
  const model = (OPENAI_CODEX_MODELS as Record<string, CodexCatalogModel>)[modelId];
  if (!model || !CODEX_MODEL_IDS.includes(modelId as CodexModelId)) {
    throw new Error(`Unsupported shared Codex model: ${modelId}`);
  }
  return model;
}

/** Project the two v1 models for a ready shared connection. */
export function projectCodexModels(status: CodexConnectionStatus): ProjectedCodexModel[] {
  if (!isReadyCodexStatus(status)) return [];
  return CODEX_MODEL_IDS.map((modelId) => {
    const catalog = codexCatalogModel(modelId);
    return {
      profile: {
        type: "agent",
        id: codexProfileId(modelId),
        name: catalog.name,
      },
      config: {
        provider: "openai-codex",
        model: modelId,
        connection: SHARED_CODEX_CONNECTION,
        connectionEpoch: status.connectionEpoch,
      },
    };
  });
}

/** Resolve a namespaced AgentOS ID within one already-read connection snapshot. */
export function resolveCodexModel(
  profileId: string,
  status: CodexConnectionStatus,
): ProjectedCodexModel | undefined {
  if (!isCodexProfileId(profileId)) return undefined;
  return projectCodexModels(status).find((entry) => entry.profile.id === profileId);
}
