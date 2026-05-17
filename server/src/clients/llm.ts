/**
 * LLM client — OpenRouter-routed, default to Gemini Flash Lite.
 *
 * Used at onboarding to generate the brand-context briefing from the
 * scraped pages. NOT used during the live call — that's AgentPhone's
 * voice agent. This is a one-shot text completion.
 *
 * MOCK mode: synthesizes a generic-but-plausible briefing so we can demo
 * the wiring without an OpenRouter key.
 */

import OpenAI from "openai";
import { env, isMock } from "./config.js";

export interface LLMClient {
  complete(opts: { system: string; user: string; maxTokens?: number }): Promise<string>;
}

class MockLLM implements LLMClient {
  async complete({ system, user }: { system: string; user: string }): Promise<string> {
    console.warn("[lasso] llm: MOCK mode");
    // Return a passable canned briefing
    const subject = user.split("\n")[0]?.slice(0, 80) ?? "the store";
    return [
      "## Brand voice",
      "Warm, knowledgeable, never pushy. Speak like a small-shop owner who actually cares about the customer.",
      "",
      "## What this store sells",
      subject,
      "",
      "## Top customer questions",
      "- Shipping speed and cost",
      "- Return policy",
      "- Product freshness / origin",
      "",
      "## What to push for on a recovery call",
      "Reference the specific cart item warmly, ask if there was a question we can answer. Offer the standard 10% recovery coupon (LASSO10) if they hesitate on price.",
    ].join("\n");
  }
}

class OpenRouterLLM implements LLMClient {
  private client: OpenAI;
  constructor(apiKey: string, private model: string) {
    this.client = new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" });
  }

  async complete({ system, user, maxTokens = 800 }: { system: string; user: string; maxTokens?: number }): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return res.choices[0]?.message?.content ?? "";
  }
}

let _client: LLMClient | null = null;

export function getLLM(): LLMClient {
  if (_client) return _client;
  if (isMock(env.openrouterKey)) {
    _client = new MockLLM();
  } else {
    _client = new OpenRouterLLM(env.openrouterKey!, env.openrouterModel);
  }
  return _client;
}
