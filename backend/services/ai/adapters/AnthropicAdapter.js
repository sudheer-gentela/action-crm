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

  async complete({ model, prompt, messages, system, maxTokens = 1024, temperature, cache }) {
    const msgs = messages || [{ role: 'user', content: prompt }];

    // ── Prompt caching (opt-in) ──────────────────────────────────────────
    // When the caller passes cache: { system: true }, the system prompt is
    // sent as a content block marked with cache_control so Anthropic caches
    // the entire prefix (tools + system) server-side. Subsequent identical
    // prefixes within the TTL are billed at 0.1x input price instead of 1x.
    //
    // Opt-in, never automatic: call sites with per-request dynamic system
    // prompts would pay the 1.25x cache-write premium on every call and
    // never get a read. Only call sites with a stable system prefix (e.g.
    // SkillRunnerService, whose system prompt is pure disk content) should
    // set this.
    //
    // cache.ttl: '1h' opts into the 1-hour cache (2x write cost) — default
    // is the 5-minute cache, refreshed free on every hit.
    //
    // Note: prompts below the model's minimum cacheable length (e.g. 1,024
    // tokens for the Sonnet/Opus 4.x families) are silently processed
    // without caching — no error, both cache usage fields come back 0.
    let systemParam = system;
    if (system && cache && cache.system) {
      const cacheControl = {
        type: 'ephemeral',
        ...(cache.ttl === '1h' ? { ttl: '1h' } : {}),
      };
      if (typeof system === 'string') {
        systemParam = [{ type: 'text', text: system, cache_control: cacheControl }];
      } else if (Array.isArray(system) && system.length > 0) {
        // Already block-structured: mark the last block (caches the full prefix).
        systemParam = system.map((b, i) =>
          i === system.length - 1 ? { ...b, cache_control: cacheControl } : b
        );
      }
    }

    const baseParams = {
      model,
      max_tokens: maxTokens,
      ...(systemParam ? { system: systemParam } : {}),
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
        // input_tokens from the API counts ONLY tokens after the last cache
        // breakpoint. Total input = input_tokens + cache_read_input_tokens
        // + cache_creation_input_tokens. TokenTrackingService and
        // SkillRunnerService own that summation.
        input_tokens:  resp.usage?.input_tokens  || 0,
        output_tokens: resp.usage?.output_tokens || 0,
        cache_creation_input_tokens: resp.usage?.cache_creation_input_tokens || 0,
        cache_read_input_tokens:     resp.usage?.cache_read_input_tokens     || 0,
        // 5m/1h write breakdown — present only when mixing TTLs; used by
        // TokenTrackingService for exact cache-write pricing.
        cache_creation: resp.usage?.cache_creation || null,
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
