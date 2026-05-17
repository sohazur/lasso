/**
 * Firecrawl client — site extraction for merchant onboarding only.
 * Not called during live calls. One-time crawl per merchant.
 *
 * MOCK mode: returns a small hand-crafted page set so onboarding works
 * end-to-end without a Firecrawl key (great for the demo store).
 */

import { env, isMock } from "./config.js";

export type CrawledPage = {
  url: string;
  title?: string;
  markdown: string;
};

export interface SiteExtractor {
  crawl(rootUrl: string, options?: { limit?: number }): Promise<CrawledPage[]>;
}

class MockFirecrawl implements SiteExtractor {
  async crawl(rootUrl: string, options: { limit?: number } = {}): Promise<CrawledPage[]> {
    console.warn(`[lasso] firecrawl: MOCK mode — returning canned demo pages for ${rootUrl}`);
    // For the demo coffee store, hand-craft a few pages so onboarding produces
    // something the agent can use during the call.
    return [
      {
        url: `${rootUrl}/`,
        title: "Acme Coffee Co.",
        markdown:
          "# Acme Coffee Co.\n\nSpecialty single-origin coffee, roasted weekly in Brooklyn.\n\n" +
          "## Featured\n- Ethiopia Yirgacheffe 12oz — $22\n- Colombia Huila 12oz — $20\n- Espresso Blend 12oz — $19",
      },
      {
        url: `${rootUrl}/products/ethiopia-yirgacheffe`,
        title: "Ethiopia Yirgacheffe — 12oz",
        markdown:
          "# Ethiopia Yirgacheffe — 12oz — $22\n\nNotes: blueberry, jasmine, brown sugar. Light roast.\n" +
          "Single-origin, washed processing. Best for filter brewing.\n\nShips within 2 business days.",
      },
      {
        url: `${rootUrl}/shipping`,
        title: "Shipping & returns",
        markdown:
          "## Shipping\n\nFree standard shipping on orders over $35 in the US.\n" +
          "International shipping: $15 flat, 5-9 business days.\n\n" +
          "## Returns\n\nUnopened bags can be returned within 30 days for a full refund.",
      },
      {
        url: `${rootUrl}/faq`,
        title: "FAQ",
        markdown:
          "## How fresh is the coffee?\n\nAll bags are roasted to order, shipped within 48 hours of roasting.\n\n" +
          "## Do you offer subscriptions?\n\nYes — every 2 weeks or every month, with 10% off.",
      },
    ];
  }
}

class FirecrawlHttp implements SiteExtractor {
  private base = "https://api.firecrawl.dev/v1";
  constructor(private apiKey: string) {}

  async crawl(rootUrl: string, options: { limit?: number } = {}): Promise<CrawledPage[]> {
    const limit = options.limit ?? 20;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };

    // Kick off the crawl
    const kickoff = await fetch(`${this.base}/crawl`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: rootUrl,
        limit,
        scrapeOptions: { formats: ["markdown"] },
      }),
    });
    if (!kickoff.ok) throw new Error(`firecrawl /crawl ${kickoff.status}: ${await kickoff.text()}`);
    const job = (await kickoff.json()) as { id: string };

    // Poll for completion (cap ~3 minutes)
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      const status = await fetch(`${this.base}/crawl/${job.id}`, { headers });
      if (!status.ok) continue;
      const j = (await status.json()) as {
        status: string;
        data?: Array<{ markdown?: string; metadata?: { sourceURL?: string; title?: string } }>;
      };
      if (j.status === "completed") {
        return (j.data ?? [])
          .filter((p): p is { markdown: string; metadata?: { sourceURL?: string; title?: string } } => !!p.markdown)
          .map((p) => ({
            url: p.metadata?.sourceURL ?? rootUrl,
            title: p.metadata?.title,
            markdown: p.markdown,
          }));
      }
      if (j.status === "failed") throw new Error(`firecrawl crawl failed`);
    }
    throw new Error(`firecrawl crawl timed out after 3 minutes`);
  }
}

let _client: SiteExtractor | null = null;

export function getFirecrawl(): SiteExtractor {
  if (_client) return _client;
  if (isMock(env.firecrawlKey)) {
    _client = new MockFirecrawl();
  } else {
    _client = new FirecrawlHttp(env.firecrawlKey!);
  }
  return _client;
}
