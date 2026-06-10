/**
 * config/aiProviders.js
 *
 * SINGLE SOURCE OF TRUTH for AI providers and their models.
 *
 * To add a new provider:
 *   1. Add an entry below with adapter, models, and default endpoint
 *   2. Add an adapter file in services/ai/adapters/<provider>.adapter.js
 *      (only needed if it doesn't speak OpenAI-compatible chat completions)
 *   3. That's it. No DB migration, no UI changes — the dropdowns are
 *      generated from this file.
 *
 * OpenAI-compatible providers (Groq, Together, DeepSeek, Mistral, xAI,
 * Anyscale, Fireworks, local Ollama, vLLM, LM Studio) just need a registry
 * entry — they reuse the openai-compatible adapter automatically.
 */

const PROVIDERS = {

  // ─────────────────────────── Anthropic ─────────────────────────────────
  anthropic: {
    label: 'Anthropic',
    adapter: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    keyHint: 'sk-ant-…',
    models: [
      { id: 'claude-fable-5',               label: 'Claude Fable 5',          tier: 'flagship' },
      { id: 'claude-opus-4-8',              label: 'Claude Opus 4.8',         tier: 'flagship' },
      { id: 'claude-opus-4-7',              label: 'Claude Opus 4.7',         tier: 'flagship' },
      { id: 'claude-opus-4-6',              label: 'Claude Opus 4.6',         tier: 'flagship' },
      { id: 'claude-sonnet-4-6',            label: 'Claude Sonnet 4.6',       tier: 'balanced' },
      { id: 'claude-haiku-4-5-20251001',    label: 'Claude Haiku 4.5',        tier: 'fast'    },
      { id: 'claude-sonnet-4-20250514',     label: 'Claude Sonnet 4 (legacy)', tier: 'balanced' },
    ],
    // Longest-prefix matched by getModelCost — generation-specific entries
    // first, bare-family entries as legacy fallbacks (Opus ≤4.1 was $15/$75;
    // Haiku 3.x was $0.80/$4).
    costPerMillion: {
      'claude-fable-5':    { input: 10,   output: 50   },
      'claude-opus-4-8':   { input:  5,   output: 25   },
      'claude-opus-4-7':   { input:  5,   output: 25   },
      'claude-opus-4-6':   { input:  5,   output: 25   },
      'claude-opus':       { input: 15,   output: 75   },
      'claude-sonnet':     { input:  3,   output: 15   },
      'claude-haiku-4-5':  { input:  1,   output:  5   },
      'claude-haiku':      { input:  0.80, output: 4.00 },
    },
  },

  // ───────────────────────────── OpenAI ──────────────────────────────────
  openai: {
    label: 'OpenAI',
    adapter: 'openai',
    envKey: 'OPENAI_API_KEY',
    keyHint: 'sk-…',
    models: [
      { id: 'gpt-5.5',        label: 'GPT-5.5',         tier: 'flagship'  },
      { id: 'gpt-5.4',        label: 'GPT-5.4',         tier: 'balanced'  },
      { id: 'gpt-5.4-mini',   label: 'GPT-5.4 mini',    tier: 'fast'      },
      { id: 'gpt-5.4-nano',   label: 'GPT-5.4 nano',    tier: 'fast'      },
      { id: 'gpt-4o',         label: 'GPT-4o (legacy)', tier: 'balanced'  },
      { id: 'gpt-4o-mini',    label: 'GPT-4o mini (legacy)', tier: 'fast' },
    ],
    costPerMillion: {
      'gpt-5.5':       { input: 5.00, output: 30.00 },
      'gpt-5.4':       { input: 1.75, output: 14.00 },
      'gpt-5.4-mini':  { input: 0.40, output:  3.20 },
      'gpt-5.4-nano':  { input: 0.12, output:  0.80 },
      'gpt-4o':        { input: 2.50, output: 10.00 },
      'gpt-4o-mini':   { input: 0.15, output:  0.60 },
    },
  },

  // ───────────────────────────── Google ──────────────────────────────────
  gemini: {
    label: 'Google Gemini',
    adapter: 'gemini',
    envKey: 'GOOGLE_AI_API_KEY',
    keyHint: 'AIza…',
    // Stable ids only — Gemini 2.0/1.5 models were shut down by Google in
    // mid-2026, and the 3.x family ships under preview ids that churn; live
    // discovery (ModelDiscoveryService) surfaces those without a redeploy.
    // Note: 2.5 Pro charges 2x input above 200K prompt tokens; the figures
    // here are the ≤200K rates used for estimation.
    models: [
      { id: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro',        tier: 'flagship' },
      { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash',      tier: 'balanced' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', tier: 'fast'     },
    ],
    costPerMillion: {
      'gemini-2.5-pro':        { input: 1.25, output: 10.00 },
      'gemini-2.5-flash-lite': { input: 0.10, output:  0.40 },
      'gemini-2.5-flash':      { input: 0.30, output:  2.50 },
    },
  },

  // ──────────────────── OpenAI-compatible providers ──────────────────────
  // These all speak the OpenAI chat-completions API. The 'openai-compatible'
  // adapter handles them with a configurable baseURL.

  groq: {
    label: 'Groq',
    adapter: 'openai-compatible',
    envKey: 'GROQ_API_KEY',
    endpoint: 'https://api.groq.com/openai/v1',
    keyHint: 'gsk_…',
    models: [
      { id: 'llama-3.3-70b-versatile',  label: 'Llama 3.3 70B',  tier: 'balanced' },
      { id: 'llama-3.1-8b-instant',     label: 'Llama 3.1 8B',   tier: 'fast'     },
      { id: 'mixtral-8x7b-32768',       label: 'Mixtral 8x7B',   tier: 'balanced' },
    ],
    costPerMillion: {
      'llama-3.3-70b': { input: 0.59, output: 0.79 },
      'llama-3.1-8b':  { input: 0.05, output: 0.08 },
      'mixtral-8x7b':  { input: 0.24, output: 0.24 },
    },
  },

  deepseek: {
    label: 'DeepSeek',
    adapter: 'openai-compatible',
    envKey: 'DEEPSEEK_API_KEY',
    endpoint: 'https://api.deepseek.com',
    keyHint: 'sk-…',
    models: [
      { id: 'deepseek-chat',     label: 'DeepSeek V3',  tier: 'balanced'  },
      { id: 'deepseek-reasoner', label: 'DeepSeek R1',  tier: 'reasoning' },
    ],
    costPerMillion: {
      'deepseek-chat':     { input: 0.27, output: 1.10 },
      'deepseek-reasoner': { input: 0.55, output: 2.19 },
    },
  },

  mistral: {
    label: 'Mistral',
    adapter: 'openai-compatible',
    envKey: 'MISTRAL_API_KEY',
    endpoint: 'https://api.mistral.ai/v1',
    keyHint: 'sk-…',
    models: [
      { id: 'mistral-large-latest',  label: 'Mistral Large',  tier: 'flagship' },
      { id: 'mistral-small-latest',  label: 'Mistral Small',  tier: 'fast'     },
    ],
    costPerMillion: {
      'mistral-large': { input: 2.00, output: 6.00 },
      'mistral-small': { input: 0.20, output: 0.60 },
    },
  },

  xai: {
    label: 'xAI (Grok)',
    adapter: 'openai-compatible',
    envKey: 'XAI_API_KEY',
    endpoint: 'https://api.x.ai/v1',
    keyHint: 'xai-…',
    models: [
      { id: 'grok-2-latest',       label: 'Grok 2',       tier: 'flagship' },
      { id: 'grok-2-mini-latest',  label: 'Grok 2 mini',  tier: 'fast'     },
    ],
    costPerMillion: {
      'grok-2':      { input: 2.00, output: 10.00 },
      'grok-2-mini': { input: 0.30, output:  0.50 },
    },
  },

  // ──────────────────────── Custom / self-hosted ─────────────────────────
  // The 'custom' provider lets users point at any OpenAI-compatible endpoint
  // (local Ollama, vLLM, LM Studio, private deployment). The endpoint_url
  // comes from ai_credentials.endpoint_url on a per-key basis.
  custom: {
    label: 'Custom (OpenAI-compatible)',
    adapter: 'openai-compatible',
    envKey: null,                            // no platform fallback
    endpoint: null,                          // must be supplied per-credential
    requiresEndpoint: true,
    keyHint: 'any string the endpoint accepts',
    models: [
      // Users type a model id manually when this provider is selected
    ],
    allowFreeFormModel: true,
    costPerMillion: { default: { input: 0, output: 0 } },  // self-hosted = no platform cost
  },
};

// ── System defaults — used when neither user nor org has set anything ────
const SYSTEM_DEFAULT = {
  provider: 'anthropic',
  model:    'claude-haiku-4-5-20251001',
};

// ── Call-type catalog — every distinct AI call type in the system ────────
// Used by the org-admin UI to expose per-call-type model overrides.
const CALL_TYPES = [
  { id: 'action_generation',         label: 'Action generation',          group: 'deals'       },
  { id: 'ai_enhancement',            label: 'AI enhancement (deals)',     group: 'deals'       },
  { id: 'email_analysis',            label: 'Email analysis',             group: 'deals'       },
  { id: 'deal_health_check',         label: 'Deal health check',          group: 'deals'       },
  { id: 'agent_proposal',            label: 'Agent proposal',             group: 'deals'       },
  { id: 'transcript_analysis',       label: 'Meeting transcript analysis', group: 'meetings'   },
  { id: 'context_suggest',           label: 'Context suggestion',         group: 'meetings'    },
  { id: 'strap_generation',          label: 'STRAP generation',           group: 'straps'      },
  { id: 'strap_ai_enhancement',      label: 'STRAP enhancement',          group: 'straps'      },
  { id: 'clm_enhancement',           label: 'Contract clause AI',         group: 'clm'         },
  { id: 'prospecting_research',      label: 'Prospect research',          group: 'prospecting' },
  { id: 'prospecting_draft',         label: 'Prospect outreach drafts',   group: 'prospecting' },
  { id: 'prospecting_ai_enhancement', label: 'Prospect AI enhancement',   group: 'prospecting' },
  { id: 'discovery_call_prep',       label: 'Discovery call prep skill',  group: 'deals'       },
  { id: 'action_completion_detect',  label: 'Action completion detection', group: 'workflow'   },
];

// ── Helpers ──────────────────────────────────────────────────────────────

function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label:           p.label,
    keyHint:         p.keyHint,
    requiresEndpoint: !!p.requiresEndpoint,
    allowFreeFormModel: !!p.allowFreeFormModel,
    models: p.models,
  }));
}

function getProvider(providerId) {
  return PROVIDERS[providerId] || null;
}

function isValidProvider(providerId) {
  return providerId in PROVIDERS;
}

function isValidModel(providerId, modelId) {
  const p = PROVIDERS[providerId];
  if (!p) return false;
  if (p.allowFreeFormModel) return typeof modelId === 'string' && modelId.length > 0;
  return p.models.some(m => m.id === modelId);
}

/**
 * Look up cost per million tokens for a given model on a given provider.
 * Matches by longest-prefix on the model id (so 'claude-sonnet-4-5' falls
 * back to 'claude-sonnet' rates).
 */
function getModelCost(providerId, modelId) {
  const p = PROVIDERS[providerId];
  if (!p) return null;
  const costs = p.costPerMillion || {};
  // Try exact match first
  if (costs[modelId]) return costs[modelId];
  // Longest-prefix match
  const keys = Object.keys(costs).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (modelId && modelId.startsWith(k)) return costs[k];
  }
  return costs.default || null;
}

// ── Provider-qualified model slots ────────────────────────────────────────
//
// A "slot" is the value stored in default_model or models_by_call_type.
// Two forms are accepted:
//
//   Qualified:   'anthropic/claude-sonnet-4-6'   (provider + model in one
//                value — the canonical form going forward; makes per-call-
//                type provider routing possible and removes the separate
//                ai_provider axis from resolution)
//   Unqualified: 'claude-sonnet-4-6'             (legacy — interpreted under
//                the caller-supplied legacyProvider, i.e. the layer's
//                ai_provider setting)
//
// Parse rule: split on the FIRST '/'. The prefix is treated as a provider
// only when it is a known provider id — otherwise the whole string is a
// legacy model id (protects free-form ids like HuggingFace 'org/model'
// paths on the custom provider).

function formatModelSlot(providerId, modelId) {
  return `${providerId}/${modelId}`;
}

function parseModelSlot(slot, legacyProvider) {
  if (typeof slot !== 'string' || !slot.trim()) return null;
  const s = slot.trim();
  const i = s.indexOf('/');
  if (i > 0) {
    const prefix = s.slice(0, i);
    if (isValidProvider(prefix)) {
      const model = s.slice(i + 1).trim();
      if (!model) return null;
      return { provider: prefix, model, qualified: true };
    }
  }
  // Unqualified (legacy) — needs a provider context to mean anything.
  if (!legacyProvider || !isValidProvider(legacyProvider)) return null;
  return { provider: legacyProvider, model: s, qualified: false };
}

module.exports = {
  PROVIDERS,
  SYSTEM_DEFAULT,
  CALL_TYPES,
  listProviders,
  getProvider,
  isValidProvider,
  isValidModel,
  getModelCost,
  formatModelSlot,
  parseModelSlot,
};
