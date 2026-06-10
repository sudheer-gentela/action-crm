/**
 * services/ai/adapters/GeminiAdapter.js
 *
 * Uses @google/generative-ai. Install with:
 *   npm install @google/generative-ai
 *
 * Gemini's SDK splits config between model construction time and call time —
 * we instantiate per call so temperature/max-tokens can change per request.
 */

const BaseAdapter = require('./BaseAdapter');

let GoogleGenerativeAI = null;
function _loadSdk() {
  if (!GoogleGenerativeAI) {
    GoogleGenerativeAI = require('@google/generative-ai').GoogleGenerativeAI;
  }
  return GoogleGenerativeAI;
}

class GeminiAdapter extends BaseAdapter {
  constructor({ apiKey, endpoint }) {
    super({ apiKey, endpoint });
    const SDK = _loadSdk();
    this.client = new SDK(apiKey);
  }

  async complete({ model, prompt, messages, system, maxTokens = 1024, temperature }) {
    const generationConfig = { maxOutputTokens: maxTokens };
    if (temperature !== undefined && temperature !== null) {
      generationConfig.temperature = temperature;
    }

    const genModel = this.client.getGenerativeModel({
      model,
      generationConfig,
      ...(system ? { systemInstruction: system } : {}),
    });

    let result;
    if (messages && messages.length > 0) {
      // Map [{role:'user'|'assistant', content}] to Gemini's [{role, parts:[{text}]}]
      const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
      result = await genModel.generateContent({ contents });
    } else {
      result = await genModel.generateContent(prompt);
    }

    const text  = result.response.text();
    const usage = result.response.usageMetadata || {};
    // Gemini 2.5+ implicit caching: usageMetadata.cachedContentTokenCount is
    // the portion of promptTokenCount served from cache (billed at ~10% of
    // input price). promptTokenCount is TOTAL input (cached included) —
    // same shape as OpenAI's prompt_tokens — while the platform convention
    // (TokenTrackingService / skill_runs) wants input_tokens = UNCACHED only,
    // with the cached portion in cache_read_input_tokens. Subtract to avoid
    // double-counting, mirroring OpenAIAdapter. Gemini implicit caching has
    // no explicit write event, so cache_creation stays 0.
    const cachedTokens = usage.cachedContentTokenCount || 0;
    return {
      text,
      usage: {
        input_tokens:  Math.max((usage.promptTokenCount || 0) - cachedTokens, 0),
        output_tokens: usage.candidatesTokenCount || 0,
        cache_read_input_tokens:     cachedTokens,
        cache_creation_input_tokens: 0,
        cache_creation: null,
      },
    };
  }

  /**
   * Gemini's models endpoint is GET /v1beta/models?key=API_KEY.
   * The @google/generative-ai SDK doesn't surface it cleanly, so we hit
   * the REST endpoint directly. Model names come back like
   * "models/gemini-2.0-flash" — we strip the "models/" prefix.
   */
  async listModels() {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(this.apiKey)}&pageSize=200`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Gemini listModels failed: ${resp.status} ${await resp.text().catch(() => '')}`);
    }
    const data = await resp.json();
    return (data.models || [])
      .filter(m => m && m.name)
      .map(m => ({
        id: m.name.replace(/^models\//, ''),
        raw: m,
      }));
  }
}

module.exports = GeminiAdapter;
