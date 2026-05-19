/**
 * services/ai/adapters/AnthropicAdapter.js
 *
 * Note on `temperature`:
 *   The Claude Opus 4.7 family (and some newer models) deprecated the
 *   `temperature` parameter — the API returns a 400 invalid_request_error
 *   if it is present at all. To stay forward-compatible without hardcoding
 *   a per-model list:
 *     1. We only send `temperature` when the caller explicitly passed one.
 *     2. If the API still rejects it (`temperature is deprecated`), we
 *        transparently retry once with the parameter stripped.
 *   This auto-heals for current and future models that drop the parameter.
 */

const BaseAdapter = require('./BaseAdapter');
const { Anthropic } = require('@anthropic-ai/sdk');

function isTemperatureDeprecatedError(err) {
  const msg = (err && (err.message || String(err))) || '';
  return /temperature/i.test(msg) && /deprecat|not supported|unsupported|invalid/i.test(msg);
}

class AnthropicAdapter extends BaseAdapter {
  constructor({ apiKey, endpoint }) {
    super({ apiKey, endpoint });
    this.client = new Anthropic({
      apiKey,
      ...(endpoint ? { baseURL: endpoint } : {}),
    });
  }

  async complete({ model, prompt, messages, system, maxTokens = 1024, temperature }) {
    const msgs = messages || [{ role: 'user', content: prompt }];

    const baseParams = {
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: msgs,
    };

    // Only include temperature if the caller explicitly supplied one.
    const params = (temperature === undefined || temperature === null)
      ? baseParams
      : { ...baseParams, temperature };

    let resp;
    try {
      resp = await this.client.messages.create(params);
    } catch (err) {
      // Opus 4.7-family models reject `temperature` outright. Retry once
      // with it stripped so the call still succeeds.
      if (params.temperature !== undefined && isTemperatureDeprecatedError(err)) {
        resp = await this.client.messages.create(baseParams);
      } else {
        throw err;
      }
    }

    const text = (resp.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    return {
      text,
      usage: {
        input_tokens:  resp.usage?.input_tokens  || 0,
        output_tokens: resp.usage?.output_tokens || 0,
      },
    };
  }

  /**
   * GET /v1/models on the Anthropic API. The SDK exposes this as
   * client.models.list(). Falls back gracefully if the installed SDK
   * version predates the models endpoint.
   */
  async listModels() {
    if (!this.client.models || typeof this.client.models.list !== 'function') {
      // Older @anthropic-ai/sdk without the models endpoint — nothing to
      // discover; the static registry remains the source of truth.
      return [];
    }
    const resp = await this.client.models.list();
    const data = resp?.data || (Array.isArray(resp) ? resp : []);
    return data
      .filter(m => m && m.id)
      .map(m => ({ id: m.id, raw: m }));
  }
}

module.exports = AnthropicAdapter;
