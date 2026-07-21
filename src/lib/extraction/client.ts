import { loadEnv } from "../../config/env.js";
import { MAX_TRANSIENT_RETRIES } from "../../config/constants.js";
import { retryWithBackoff } from "../queue/backoff.js";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "file"; file: { filename: string; file_data: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

function isRetryableOpenRouterError(error: unknown): boolean {
  if (error instanceof OpenRouterError) {
    return error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}

interface OpenRouterChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * OpenAI-compatible chat-completions call against OpenRouter, targeting a
 * Claude model (see OPENROUTER_MODEL). Explicitly pins the PDF-handling
 * plugin engine to "native" — Claude's own document input, not OpenRouter's
 * OCR/markdown fallback parsers — since invoice-field precision depends on
 * it, and a transient routing issue should never silently substitute a
 * lossier engine.
 *
 * ASSUMPTION FLAGGED FOR VERIFICATION: the `plugins` request shape below
 * (`{ id: "file-parser", pdf: { engine: "native" } }`) reflects OpenRouter's
 * documented PDF-processing engines (native / mistral-ocr / cloudflare-ai),
 * but the exact plugin config field names should be confirmed against
 * OpenRouter's current API reference before this is relied on in
 * production — a wrong shape most likely either has no effect (OpenRouter
 * ignores unrecognized plugin config) or 400s outright, both of which are
 * safe failure modes to catch in testing rather than a silent data-quality
 * issue.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options: { temperature?: number } = {},
): Promise<string> {
  const env = loadEnv();

  return retryWithBackoff(
    async () => {
      const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env.OPENROUTER_MODEL,
          messages,
          temperature: options.temperature ?? 0,
          plugins: [{ id: "file-parser", pdf: { engine: "native" } }],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "<no body>");
        throw new OpenRouterError(
          `OpenRouter request failed (${response.status}): ${body}`,
          response.status,
        );
      }

      const data = (await response.json()) as OpenRouterChatResponse;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("OpenRouter response did not contain assistant text content");
      }
      return content;
    },
    isRetryableOpenRouterError,
    { maxAttempts: MAX_TRANSIENT_RETRIES },
  );
}
