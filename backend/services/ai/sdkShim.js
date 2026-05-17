/**
 * services/ai/sdkShim.js
 *
 * BACKWARDS-COMPATIBLE SHIM.
 *
 * Lets the existing 21 call sites keep working — `new Anthropic({apiKey})`
 * and `new OpenAI({apiKey})` continue to function unchanged — while NEW
 * call sites that pass orgId/userId metadata route through AIClientResolver.
 *
 * The shim does NOT migrate existing code. It just keeps the old code
 * functional during a staged rollout so the new admin UI is usable
 * immediately. Once all call sites are migrated to AIClientResolver
 * directly, delete this file and remove the require() from server.js.
 *
 * INSTALL — add to top of server.js, BEFORE any service imports:
 *
 *   require('./services/ai/sdkShim');
 *
 * The shim replaces the SDK exports in the require cache, so all
 * subsequent `require('@anthropic-ai/sdk')` calls get the shimmed versions.
 *
 * MIGRATION SEMANTICS:
 *
 *   // Legacy path — keeps working
 *   const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
 *   await anthropic.messages.create({ model: 'claude-haiku-…', ... });
 *
 *   // Opt-in new path — gradually migrate call sites by adding metadata
 *   await anthropic.messages.create(
 *     { model: 'overridden-internally', ... },
 *     { orgId, userId, callType: 'action_generation' }   // <- 2nd arg
 *   );
 *
 *   // Best path — call AIClientResolver directly
 *   const { adapter, model } = await AIClientResolver.resolve(orgId, userId, 'action_generation');
 *   await adapter.complete({ model, prompt, maxTokens: 1000 });
 */

const path = require('path');

// ── Anthropic shim ────────────────────────────────────────────────────────
try {
  const anthropicPkg = require('@anthropic-ai/sdk');
  const RealAnthropic = anthropicPkg.Anthropic;

  class ShimAnthropic extends RealAnthropic {
    constructor(opts) {
      super(opts);
      const realMessages = this.messages;
      this.messages = {
        ...realMessages,
        create: async (params, metadata) => {
          // No metadata → legacy passthrough
          if (!metadata || metadata.orgId === undefined) {
            return realMessages.create.call(realMessages, params);
          }

          // Metadata provided → route through resolver for proper model + key
          const AIClientResolver = require('./AIClientResolver');
          const { adapter, model, provider, keySource } =
            await AIClientResolver.resolve(metadata.orgId, metadata.userId, metadata.callType);

          // Adapter knows how to call its own SDK. We expose the underlying
          // client so this shim can use it directly (avoids translating the
          // params object both ways).
          if (provider === 'anthropic' && adapter.client) {
            const resp = await adapter.client.messages.create({ ...params, model });
            // Attach metadata so caller can log it without re-resolving
            resp._gowarm_meta = { model, provider, keySource };
            return resp;
          }

          // If org switched provider, fall back to adapter's uniform interface
          const prompt = params.messages?.[0]?.content || '';
          const { text, usage } = await adapter.complete({
            model,
            prompt,
            maxTokens: params.max_tokens || 1024,
            temperature: params.temperature ?? 0.3,
            system: params.system,
            messages: params.messages,
          });
          return {
            content: [{ type: 'text', text }],
            usage:   { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
            model,
            _gowarm_meta: { model, provider, keySource },
          };
        },
      };
    }
  }

  // Replace export in require cache
  anthropicPkg.Anthropic = ShimAnthropic;
  console.log('[sdkShim] @anthropic-ai/sdk shimmed');
} catch (err) {
  console.warn('[sdkShim] Anthropic SDK not present, skipping shim:', err.message);
}

// ── OpenAI shim ───────────────────────────────────────────────────────────
try {
  const openaiPkg  = require('openai');
  const RealOpenAI = openaiPkg.default || openaiPkg;   // CJS/ESM dual-export

  class ShimOpenAI extends RealOpenAI {
    constructor(opts) {
      super(opts);
      const realCreate = this.chat.completions.create.bind(this.chat.completions);
      this.chat.completions.create = async (params, metadata) => {
        if (!metadata || metadata.orgId === undefined) {
          return realCreate(params);
        }
        const AIClientResolver = require('./AIClientResolver');
        const { adapter, model, provider, keySource } =
          await AIClientResolver.resolve(metadata.orgId, metadata.userId, metadata.callType);

        if ((provider === 'openai' || provider === 'openai-compatible') && adapter.client) {
          const resp = await adapter.client.chat.completions.create({ ...params, model });
          resp._gowarm_meta = { model, provider, keySource };
          return resp;
        }

        // Cross-provider fall-through
        const prompt = params.messages?.find(m => m.role === 'user')?.content || '';
        const { text, usage } = await adapter.complete({
          model, prompt,
          maxTokens: params.max_tokens || 1024,
          temperature: params.temperature ?? 0.3,
        });
        return {
          choices: [{ message: { role: 'assistant', content: text } }],
          usage:   { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens },
          model,
          _gowarm_meta: { model, provider, keySource },
        };
      };
    }
  }

  // OpenAI exports both as default and a named export depending on version.
  // Patch the export in place so `require('openai')` gives the shim.
  if (openaiPkg.default) openaiPkg.default = ShimOpenAI;
  if (openaiPkg.OpenAI)  openaiPkg.OpenAI  = ShimOpenAI;
  module.exports = ShimOpenAI;
  console.log('[sdkShim] openai SDK shimmed');
} catch (err) {
  console.warn('[sdkShim] OpenAI SDK not present, skipping shim:', err.message);
}
