/**
 * Markdown chunker. Modeled on Foyer's heading-aware splitter:
 *   - Target ~500 tokens per chunk (4 chars/token estimate)
 *   - Splits on H1/H2/H3 boundaries
 *   - FAQ sections emit one chunk per Q+A pair
 *   - Hash-dedup by sha256(content + url)
 */

import { createHash } from "node:crypto";

export type Chunk = {
  id: string; // sha256(text + url), stable for idempotent re-ingest
  text: string;
  pageUrl: string;
  pageTitle?: string;
  sectionTitle?: string;
  tokenCount: number;
};

const TARGET_TOKENS = 500;
const MAX_TOKENS = 1500;
const CHARS_PER_TOKEN = 4;

export function chunkPage(opts: { url: string; title?: string; markdown: string }): Chunk[] {
  const sections = splitByHeadings(opts.markdown);
  const out: Chunk[] = [];

  for (const section of sections) {
    if (isFaqSection(section.title ?? "")) {
      out.push(...splitFaqPairs(section, opts.url, opts.title));
    } else {
      out.push(...packParagraphs(section, opts.url, opts.title));
    }
  }

  return dedupe(out);
}

type Section = {
  title?: string;
  body: string;
};

function splitByHeadings(md: string): Section[] {
  const lines = md.split(/\r?\n/);
  const sections: Section[] = [];
  let current: Section = { body: "" };

  for (const line of lines) {
    const match = /^(#{1,3})\s+(.*)$/.exec(line);
    if (match) {
      if (current.body.trim().length > 0 || current.title) sections.push(current);
      current = { title: match[2]!.trim(), body: "" };
    } else {
      current.body += line + "\n";
    }
  }
  if (current.body.trim().length > 0 || current.title) sections.push(current);
  return sections.length > 0 ? sections : [{ body: md }];
}

function isFaqSection(title: string): boolean {
  return /\b(faq|q\s*&\s*a|questions)\b/i.test(title);
}

function splitFaqPairs(section: Section, url: string, pageTitle?: string): Chunk[] {
  // Match patterns like "## Question?" "Answer..." OR "**Q:** ... **A:** ..."
  const text = section.body;
  const pairs: string[] = [];

  // Strategy 1: question-like lines (ending in ?) followed by an answer block
  const qLineRe = /^(##+\s+.+\?|\*\*Q.*?\*\*.*?$|.+\?\s*$)/gm;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  const matches: number[] = [];
  while ((match = qLineRe.exec(text)) !== null) {
    matches.push(match.index);
  }
  if (matches.length >= 2) {
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i]!;
      const end = i + 1 < matches.length ? matches[i + 1]! : text.length;
      pairs.push(text.slice(start, end).trim());
    }
  }

  if (pairs.length === 0) {
    // Fall back to paragraph packing
    return packParagraphs(section, url, pageTitle);
  }

  return pairs
    .filter((p) => p.length > 20)
    .map((p) => makeChunk(p, url, pageTitle, section.title));
}

function packParagraphs(section: Section, url: string, pageTitle?: string): Chunk[] {
  const paragraphs = section.body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: Chunk[] = [];
  let buf = "";

  for (const p of paragraphs) {
    const candidate = buf ? `${buf}\n\n${p}` : p;
    if (estimateTokens(candidate) > MAX_TOKENS && buf) {
      out.push(makeChunk(buf, url, pageTitle, section.title));
      buf = p;
    } else if (estimateTokens(candidate) >= TARGET_TOKENS) {
      out.push(makeChunk(candidate, url, pageTitle, section.title));
      buf = "";
    } else {
      buf = candidate;
    }
  }

  if (buf.trim().length > 0) {
    out.push(makeChunk(buf, url, pageTitle, section.title));
  }

  // If a section produced nothing (very short), still emit a single chunk
  // so we don't drop the content silently
  if (out.length === 0 && section.body.trim().length > 0) {
    out.push(makeChunk(section.body.trim(), url, pageTitle, section.title));
  }

  return out;
}

function makeChunk(text: string, url: string, pageTitle?: string, sectionTitle?: string): Chunk {
  const trimmed = text.trim();
  return {
    id: hashChunk(trimmed, url),
    text: sectionTitle ? `${sectionTitle}\n\n${trimmed}` : trimmed,
    pageUrl: url,
    pageTitle,
    sectionTitle,
    tokenCount: estimateTokens(trimmed),
  };
}

function hashChunk(text: string, url: string): string {
  return createHash("sha256").update(`${url}::${text}`).digest("hex").slice(0, 16);
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

function dedupe(chunks: Chunk[]): Chunk[] {
  const seen = new Set<string>();
  const out: Chunk[] = [];
  for (const c of chunks) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}
