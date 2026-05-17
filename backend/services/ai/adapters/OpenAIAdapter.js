/**
 * services/ai/adapters/OpenAIAdapter.js
 *
 * Also used by openai-compatible providers (Groq, DeepSeek, Mistral, xAI,
 * Together, vLLM, Ollama, LM Studio, etc.) — the only difference is a
 * configurable baseURL passed in via the endpoint constructor arg.
 */

const BaseAdapter = require('./BaseAdapter');
const OpenAI      = require('openai');

class OpenAIAdapter extends BaseAdapter {
  constructor({ apiKey, endpoint }) {
    super({ apiKey, endpoint });
    this.client = new OpenAI({
      apiKey,
      ...(endpoint ? { baseURL: endpoint } : {}),
    });
  }

  async complete({ model, prompt, messages, system, maxTokens = 1024, temperature = 0.3 }) {
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    if (messages) msgs.push(...messages);
    else if (prompt) msgs.push({ role: 'user', content: prompt });

    const resp = await this.client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: msgs,
    });

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
