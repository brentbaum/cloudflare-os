import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { AiChatAuthorInfo, AiChatMetadata } from "@gadgets/workshop-shared/api";
import type { AiGatewayLogRoute } from "../src/ai-gateway.js";
import type { OverseerDurableObject } from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_OVERSEER: DurableObjectNamespace<OverseerDurableObject>;
  }
}

const AUTHOR: AiChatAuthorInfo = { type: "agent", id: "model-id", name: "Model" };

describe("AI Gateway cost persistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries and records a cross-account log cost on the matching chat and gadget", async () => {
    const fetchMock = vi.fn(async () => fetchMock.mock.calls.length === 1
      ? new Response(null, { status: 404 })
      : Response.json({ success: true, result: { cost: 1.25 } }));
    vi.stubGlobal("fetch", fetchMock);

    const stub = env.TEST_OVERSEER.getByName("ai-gateway-cost");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const overseer = instance as unknown as {
        impl: {
          storage: {
            chatMeta: {
              put(meta: AiChatMetadata): void;
              get(id: number): AiChatMetadata | undefined;
            };
            totalCost: { get(): number };
          };
          addChatMessages(
            chatId: number,
            author: AiChatAuthorInfo,
            messages: [],
            totalTokens?: number,
            logId?: string,
            route?: AiGatewayLogRoute,
            estimatedCost?: number,
            costUnknown?: boolean,
          ): void;
        };
      };
      overseer.impl.storage.chatMeta.put({
        id: 7,
        title: "Chat",
        started: new Date(0),
        lastActive: new Date(0),
      });

      overseer.impl.addChatMessages(7, AUTHOR, [], undefined, "log-id", {
        accountId: "gateway-account-id",
        gateway: "platform-gateway",
        apiToken: "read-run-token",
      });

      await vi.waitFor(() => {
        expect(overseer.impl.storage.chatMeta.get(7)?.totalCost).toBe(1.25);
      }, { timeout: 3000 });
      expect(overseer.impl.storage.totalCost.get()).toBe(1.25);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 5000);

  it("marks Codex-only and mixed-provider totals unknown instead of displaying zero", async () => {
    const stub = env.TEST_OVERSEER.getByName("codex-unknown-cost");
    await runInDurableObject(stub, async (instance: OverseerDurableObject) => {
      const overseer = instance as unknown as {
        impl: {
          storage: {
            chatMeta: {
              put(meta: AiChatMetadata): void;
              get(id: number): AiChatMetadata | undefined;
            };
            totalCost: { get(): number | null };
          };
          addChatMessages(
            chatId: number,
            author: AiChatAuthorInfo,
            messages: [],
            totalTokens?: number,
            logId?: string,
            route?: AiGatewayLogRoute,
            estimatedCost?: number,
            costUnknown?: boolean,
          ): void;
        };
      };
      const meta = (id: number): AiChatMetadata => ({
        id, title: "Chat", started: new Date(id), lastActive: new Date(id),
      });
      overseer.impl.storage.chatMeta.put(meta(7));
      overseer.impl.storage.chatMeta.put(meta(8));

      // Chat 7 first accrues a known direct-provider estimate, then uses the subscription.
      overseer.impl.addChatMessages(7, AUTHOR, [], undefined, undefined, undefined, 1.25);
      expect(overseer.impl.storage.chatMeta.get(7)?.totalCost).toBe(1.25);
      overseer.impl.addChatMessages(7, AUTHOR, [], undefined, undefined, undefined, 0, true);

      // Chat 8 is subscription-only. Both it and the mixed workspace are explicitly unknown.
      overseer.impl.addChatMessages(8, AUTHOR, [], undefined, undefined, undefined, 0, true);
      expect(overseer.impl.storage.chatMeta.get(7)?.totalCost).toBeNull();
      expect(overseer.impl.storage.chatMeta.get(8)?.totalCost).toBeNull();
      expect(overseer.impl.storage.totalCost.get()).toBeNull();

      // Later priced calls cannot turn an incomplete mixed total back into a numeric subtotal.
      overseer.impl.addChatMessages(7, AUTHOR, [], undefined, undefined, undefined, 2.5);
      expect(overseer.impl.storage.chatMeta.get(7)?.totalCost).toBeNull();
      expect(overseer.impl.storage.totalCost.get()).toBeNull();
    });
  });
});
