/**
 * services/ai/adapters/OpenAIAdapter.js
 *
 * Also used by openai-compatible providers (Groq, DeepSeek, Mistral, xAI,
 * Together, vLLM, Ollama, LM Studio, etc.) — the only difference is a
 * configurable baseURL passed in via the endpoint constructor arg.
 *
 * Note on `temperature`:
 *   OpenAI reasoning models (o1, o3, o3-mini, gpt-5 family) reject the
 *   `temperature` parameter — the API returns a 400. As with the Anthropic
 *   adapter, we only send `temperature` when the caller explicitly passed
 *   one, and retry once with it stripped if the API rejects it. This keeps
 *   the adapter forward-compatible without a hardcoded model list.
 */

const BaseAdapter = require('./BaseAdapter');
const OpenAI      = require('openai');

function isTemperatureRejectedError(err) {
  const msg = (err && (err.message || String(err))) || '';
  return /temperature/i.test(msg)
      && /deprecat|not supported|unsupported|does not support|invalid|unknown/i.test(msg);
}

class OpenAIAdapter extends BaseAdapter {
  constructor({ apiKey, endpoint }) {
    super({ apiKey, endpoint });
    this.client = new OpenAI({
      apiKey,
      ...(endpoint ? { baseURL: endpoint } : {}),
    });
  }

  async complete({ model, prompt, messages, system, maxTokens = 1024, temperature }) {
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    if (messages) msgs.push(...messages);
    else if (prompt) msgs.push({ role: 'user', content: prompt });

    const baseParams = {
      model,
      max_tokens: maxTokens,
      messages: msgs,
    };

    // Only include temperature if the caller explicitly supplied one.
    const params = (temperature === undefined || temperature === null)
      ? baseParams
      : { ...baseParams, temperature };

    let resp;
    try {
      resp = await this.client.chat.completions.create(params);
    } catch (err) {
      if (params.temperature !== undefined && isTemperatureRejectedError(err)) {
        resp = await this.client.chat.completions.create(baseParams);
      } else {
        throw err;
      }
    }

    const text  = resp.choices?.[0]?.message?.content || '';
    const usage = resp.usage || {};
    return {
      text,
      usage: {
        input_tokens:  usage.prompt_tokens     || 0,
        output_tokens: usage.completion_tokens || 0,
      },
    };
  }
}

module.exports = OpenAIAdapter;
