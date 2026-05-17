/**
 * services/ai/adapters/AnthropicAdapter.js
 */

const BaseAdapter = require('./BaseAdapter');
const { Anthropic } = require('@anthropic-ai/sdk');

class AnthropicAdapter extends BaseAdapter {
  constructor({ apiKey, endpoint }) {
    super({ apiKey, endpoint });
    this.client = new Anthropic({
      apiKey,
      ...(endpoint ? { baseURL: endpoint } : {}),
    });
  }

  async complete({ model, prompt, messages, system, maxTokens = 1024, temperature = 0.3 }) {
    const msgs = messages || [{ role: 'user', content: prompt }];
    const resp = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      ...(system ? { system } : {}),
      messages: msgs,
    });

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
}

module.exports = AnthropicAdapter;
