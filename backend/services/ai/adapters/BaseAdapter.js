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
   * @returns {Promise<{ text: string, usage: { input_tokens, output_tokens } }>}
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
}

module.exports = BaseAdapter;
