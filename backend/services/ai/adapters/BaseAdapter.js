/**
 * services/ai/adapters/BaseAdapter.js
 *
 * Uniform interface every provider adapter implements.
 *
 * The goal: every call site in the codebase looks like
 *
 *     const { adapter, model } = await AIClientResolver.resolve(...);
 *     const { text, usage } = await adapter.complete({ model, prompt, maxTokens });
 *
 * regardless of whether the underlying provider is Anthropic, OpenAI, Gemini,
 * Groq, DeepSeek, or a self-hosted Ollama instance. Call sites never deal
 * with provider-specific SDK shapes.
 */

class BaseAdapter {
  constructor({ apiKey, endpoint }) {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
  }

  /**
   * Single-turn completion.
   *
   * @param {object} args
   * @param {string} args.model
   * @param {string} args.prompt          OR args.messages — adapters accept either
   * @param {Array}  [args.messages]      [{ role, content }]
   * @param {string} [args.system]        system prompt
   * @param {number} [args.maxTokens=1024]
   * @param {number} [args.temperature=0.3]
   * @param {object} [args.cache]         Prompt-caching opt-in (Anthropic only;
   *                                      other adapters ignore it).
   *                                      { system: true } caches the system
   *                                      prefix; { system: true, ttl: '1h' }
   *                                      uses the 1-hour cache (2x write cost).
   *                                      ONLY set this from call sites whose
   *                                      system prompt is byte-identical across
   *                                      requests — a dynamic system prompt
   *                                      pays cache-write premiums with no hits.
   * @returns {Promise<{ text: string, usage: {
   *   input_tokens,                  // UNCACHED input tokens only
   *   output_tokens,
   *   cache_read_input_tokens,      // input served from cache (0.1x price)
   *   cache_creation_input_tokens,  // input written to cache (1.25x price, 5m)
   *   cache_creation,               // { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } | null
   * } }>}
   *   Total input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens.
   *   Adapters without cache support return 0 / null for the cache fields.
   */
  // eslint-disable-next-line no-unused-vars
  async complete(args) {
    throw new Error('complete() must be implemented by subclass');
  }

  /**
   * Cheap liveness check used by the "Test connection" admin button.
   * Most providers can do this by sending a 1-token prompt.
   */
  async ping(model) {
    // Deliberately omit `temperature` — newer models (Opus 4.7 family,
    // OpenAI reasoning models) reject it outright. A liveness check has
    // no need for it anyway.
    const { text } = await this.complete({
      model,
      prompt: 'ping',
      maxTokens: 5,
    });
    return typeof text === 'string';
  }

  /**
   * List the models this provider currently exposes.
   * Used by ModelDiscoveryService for the weekly cron + on-demand refresh.
   *
   * @returns {Promise<Array<{ id: string, raw?: object }>>}
   *   Each entry is at minimum { id }. `raw` is the provider's original
   *   model object, stored for reference.
   *
   * Adapters that cannot enumerate models (e.g. a custom self-hosted
   * endpoint) should return [] rather than throw.
   */
  async listModels() {
    return [];
  }
}

module.exports = BaseAdapter;
