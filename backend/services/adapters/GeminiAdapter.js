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

  async complete({ model, prompt, messages, system, maxTokens = 1024, temperature = 0.3 }) {
    const generationConfig = { maxOutputTokens: maxTokens, temperature };

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
    return {
      text,
      usage: {
        input_tokens:  usage.promptTokenCount     || 0,
        output_tokens: usage.candidatesTokenCount || 0,
      },
    };
  }
}

module.exports = GeminiAdapter;
