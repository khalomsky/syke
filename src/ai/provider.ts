/**
 * AI Provider abstraction — Multi-AI support (Gemini, OpenAI, Anthropic)
 * Automatically selects the best available provider based on API keys.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { getConfig } from "../config";

export interface AIProvider {
  name: string;
  analyze(systemPrompt: string, userPrompt: string): Promise<string>;
  analyzeJSON<T>(systemPrompt: string, userPrompt: string): Promise<T>;
}

// ── Gemini ──────────────────────────────────────────────────────────

class GeminiProvider implements AIProvider {
  name = "Gemini (gemini-2.5-flash)";
  private ai: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenerativeAI(apiKey);
  }

  async analyze(systemPrompt: string, userPrompt: string): Promise<string> {
    const model = this.ai.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      systemInstruction: { role: "model", parts: [{ text: systemPrompt }] },
    });
    return result.response.text();
  }

  async analyzeJSON<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const text = await this.analyze(systemPrompt, userPrompt);
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1];
    return JSON.parse(jsonStr.trim());
  }
}

// ── OpenAI ──────────────────────────────────────────────────────────

class OpenAIProvider implements AIProvider {
  name = "OpenAI (gpt-4o-mini)";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async analyze(systemPrompt: string, userPrompt: string): Promise<string> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    return data.choices[0].message.content;
  }

  async analyzeJSON<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    return JSON.parse(data.choices[0].message.content);
  }
}

// ── Anthropic ───────────────────────────────────────────────────────

class AnthropicProvider implements AIProvider {
  name = "Claude (claude-sonnet-4-20250514)";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async analyze(systemPrompt: string, userPrompt: string): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      content: { type: string; text: string }[];
    };
    return data.content[0].text;
  }

  async analyzeJSON<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    const text = await this.analyze(
      systemPrompt + "\n\nRespond with JSON only. No explanatory text, just pure JSON.",
      userPrompt
    );
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1];
    return JSON.parse(jsonStr.trim());
  }
}

// ── Factory ─────────────────────────────────────────────────────────

let cachedProvider: AIProvider | null | undefined = undefined;

/**
 * Returns the best available AI provider, or null if no API key is set.
 *
 * Priority:
 * 1. SYKE_AI_PROVIDER env var forces a specific provider
 * 2. Auto-select: GEMINI_KEY > OPENAI_KEY > ANTHROPIC_KEY
 */
export function getAIProvider(): AIProvider | null {
  if (cachedProvider !== undefined) return cachedProvider;

  const forced = getConfig("aiProvider", "SYKE_AI_PROVIDER")?.toLowerCase();
  const geminiKey = getConfig("geminiKey", "GEMINI_KEY");
  const openaiKey = getConfig("openaiKey", "OPENAI_KEY");
  const anthropicKey = getConfig("anthropicKey", "ANTHROPIC_KEY");

  if (forced) {
    if (forced === "gemini" && geminiKey) {
      cachedProvider = new GeminiProvider(geminiKey);
    } else if (forced === "openai" && openaiKey) {
      cachedProvider = new OpenAIProvider(openaiKey);
    } else if (forced === "anthropic" && anthropicKey) {
      cachedProvider = new AnthropicProvider(anthropicKey);
    } else {
      console.error(
        `[syke] SYKE_AI_PROVIDER=${forced} but no matching API key found`
      );
      cachedProvider = null;
    }
    return cachedProvider;
  }

  // Auto-select
  if (geminiKey) {
    cachedProvider = new GeminiProvider(geminiKey);
  } else if (openaiKey) {
    cachedProvider = new OpenAIProvider(openaiKey);
  } else if (anthropicKey) {
    cachedProvider = new AnthropicProvider(anthropicKey);
  } else {
    cachedProvider = null;
  }

  return cachedProvider;
}

/**
 * Reset the cached provider so the next getAIProvider() call re-evaluates config.
 * Call this after changing API keys at runtime.
 */
export function resetAIProvider(): void {
  cachedProvider = undefined;
}

/**
 * Human-readable name for the active AI provider (for logs/UI).
 */
export function getProviderName(): string {
  const provider = getAIProvider();
  return provider ? provider.name : "disabled";
}
