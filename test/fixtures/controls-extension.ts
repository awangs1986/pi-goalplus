import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { registerGoalCommands, renderGoal } from "../../src/commands.js";
import { createGoalStore } from "../../src/store.js";
import goalPlus from "../../src/index.js";

export default function controlsFixture(pi: ExtensionAPI) {
  const store = createGoalStore(pi, renderGoal);
  pi.registerProvider("goal-controls-fixture", {
    api: "goal-controls-fixture",
    apiKey: "local-fixture",
    baseUrl: "http://127.0.0.1:1",
    models: [
      {
        id: "fixture",
        name: "Goal controls fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096
      }
    ],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "text", text: "Fixture turn settled" }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: "stop",
        timestamp: Date.now()
      };
      if (process.env.GOAL_CONTROLS_HOLD === "1") {
        const abort = () => stream.push({
          type: "error",
          reason: "aborted",
          error: { ...message, stopReason: "aborted" }
        });
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      } else {
        queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
      }
      return stream;
    }
  });
  if (process.env.GOAL_CONTROLS_INTEGRATED === "1") {
    goalPlus(pi);
    pi.registerCommand("fixture-park-active", {
      description: "Prepare a locally verified active Goal at a settled boundary",
      handler: async (_args, ctx) => {
        const goal = store.read(ctx);
        if (goal?.status !== "paused" || goal.dispatch) throw Error("Fixture requires a settled, paused Goal.");
        store.write(ctx, { ...goal, status: "active", reason: undefined });
      }
    });
    pi.registerCommand("fixture-legacy-goal", {
      description: "Append an unsigned legacy Goal snapshot",
      handler: async () => pi.appendEntry("pi-goalplus:state", {
        schema: 1,
        goal: {
          schema: 1,
          id: "fixture-legacy-goal",
          revision: 1,
          status: "active",
          objective: "Check imported fixtures",
          constraints: [],
          criteria: [{ id: "c1", requirement: "Fixture is reviewed", verification: "Review the fixture" }],
          evidence: [],
          tokensUsed: 0,
          noProgress: 0,
        }
      })
    });
    return;
  }
  let requested = false;
  registerGoalCommands(pi, store, {
    beforeNextStage: () => false,
    compacting: () => false,
    request() {
      requested = true;
      pi.sendUserMessage("Run the approved controls fixture.", { expandPromptTemplates: false });
    },
    current(ctx) {
      return requested && !ctx.isIdle() ? "fixture-run" : undefined;
    }
  });
  pi.on("agent_settled", () => {
    requested = false;
  });
  pi.registerCommand("fixture-budget", {
    description: "Set up a budget-limited Goal for the command tests",
    handler: async (_args, ctx) => {
      const goal = store.read(ctx);
      if (!goal || goal.budgetTokens === undefined) throw Error("No explicit Goal budget");
      store.write(ctx, {
        ...goal,
        status: "budgetLimited",
        reason: "Test budget exhausted",
        tokensUsed: goal.budgetTokens
      });
    }
  });
  pi.registerCommand("fixture-invalid", {
    description: "Set up an invalid persisted snapshot",
    handler: async () => pi.appendEntry("pi-goalplus:state", { schema: 2 })
  });
}
