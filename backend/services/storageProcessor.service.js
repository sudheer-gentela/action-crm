/**
 * storageProcessor.service.js
 * Provider-agnostic orchestration layer.
 * All requires point to sibling files in services/ (flat structure).
 */

const { getProvider }      = require('./StorageProviderFactory');
const { checkDuplicate, createImportRecord, markProcessed, markFailed } = require('./storageFileService');
const aiProcessor          = require('./aiProcessor');
const ActionsEngine        = require('./ActionsEngine');
const transcriptAnalyzer   = require('./transcriptAnalyzer');
const { applyAISignals, detectCompetitors, scoreDeal } = require('./dealHealthService');

const PIPELINE_CONFIG = {
  transcript: ['transcriptAnalyzer', 'aiAnalysis', 'rulesEngine', 'dealHealth'],
  document:   ['aiAnalysis', 'rulesEngine', 'dealHealth'],
  email:      ['aiAnalysis', 'rulesEngine'],
};

async function processStorageFile(userId, providerId, fileId, options = {}) {
  const { dealId, contactId, dryRun = false, force = false } = options;
  const provider = getProvider(providerId);

  // Pre-download duplicate check
  if (!dryRun && !force) {
    const dup = await checkDuplicate(userId, providerId, fileId, dealId);
    if (dup.exists) {
      const err = new Error(dup.message);
      err.code = 'DUPLICATE_IMPORT';
      err.existingRecord = dup.record;
      throw err;
    }
  }

  const content = await provider.extractFileContent(userId, fileId);
  console.log(`[StorageProcessor] "${content.fileName}" via ${provider.displayName} (${content.category}, ${content.characterCount} chars)`);

  let importRecord = null;
  if (!dryRun) {
    importRecord = await createImportRecord(content.fileRef, userId, dealId, contactId, force);
  }

  const defaultPipelines = PIPELINE_CONFIG[content.category] || PIPELINE_CONFIG.document;
  const pipelines = options.pipelines || defaultPipelines;
  const sourceLabel = importRecord
    ? importRecord.source_label
    : `${provider.displayName}: ${content.fileName}`;

  let pipelineResults;
  try {
    pipelineResults = await runPipelines(pipelines, content, { ...options, sourceLabel }, userId);
  } catch (err) {
    if (importRecord && !dryRun) await markFailed(importRecord.id, err.message);
    throw err;
  }

  if (importRecord && !dryRun) {
    await markProcessed(importRecord.id, extractInsights(pipelines, pipelineResults));
  }

  return {
    file: {
      id: content.fileId, name: content.fileName, category: content.category,
      characterCount: content.characterCount, provider: content.provider,
      webUrl: content.fileRef.web_url, sourceLabel,
      importRecordId: importRecord ? importRecord.id : null,
    },
    pipelinesRun: pipelines,
    results: pipelineResults,
  };
}

async function runPipelines(pipelines, content, options, userId) {
  const results = {};
  await Promise.allSettled(
    pipelines.map(async (pipeline) => {
      try {
        results[pipeline] = await runPipeline(pipeline, content, options, userId);
      } catch (err) {
        console.error(`[StorageProcessor] Pipeline "${pipeline}" failed:`, err.message);
        results[pipeline] = { error: err.message, success: false };
      }
    })
  );
  return results;
}

async function runPipeline(pipeline, content, options, userId) {
  const { rawText, fileName, category, fileId } = content;
  const { dealId, contactId, dryRun, sourceLabel } = options;

  switch (pipeline) {
    case 'transcriptAnalyzer': {
      const analysis = await transcriptAnalyzer.analyze({
        text: rawText,
        metadata: { source: content.provider, sourceFileId: fileId, fileName, dealId, contactId },
      });
      return { success: true, ...analysis };
    }

    case 'aiAnalysis': {
      const context = buildAiContext(category, content, options);
      const analysis = await aiProcessor.processContent(rawText, context);
      return { success: true, ...analysis };
    }

    case 'rulesEngine': {
      const event = {
        type: 'storage_file_imported', source: 'storage_file',
        source_id: sourceLabel, fileId, fileName, category,
        content: rawText, dealId, contactId, userId,
      };
      const actions = await ActionsEngine.processEvent(event, { dryRun: !!dryRun });
      return { success: true, actionsGenerated: actions.length, actions };
    }

    case 'dealHealth': {
      if (!dealId) return { success: false, skipped: true, reason: 'No dealId provided.' };
      const sourceType   = `${content.provider}_${category}`;
      const signals      = await applyAISignals(dealId, rawText, sourceType, userId);
      const competitors  = await detectCompetitors(dealId, userId, rawText);
      const healthResult = await scoreDeal(dealId, userId);
      return {
        success: true,
        signalsApplied: Object.keys(signals).length, signals,
        competitorsDetected: competitors.length, competitors,
        healthScore: healthResult.score, healthStatus: healthResult.health,
      };
    }

    default:
      throw new Error(`Unknown pipeline: "${pipeline}"`);
  }
}

function extractInsights(pipelines, results) {
  const insights = { pipelinesRun: pipelines };
  const ai = results.aiAnalysis;
  if (ai && ai.success) {
    insights.aiSummary      = ai.summary      || null;
    insights.aiActionItems  = ai.action_items || ai.actionItems || null;
    insights.aiSentiment    = ai.sentiment    || null;
    insights.aiAnalysisType = ai.analysisType || null;
  }
  const dh = results.dealHealth;
  if (dh && dh.success && !dh.skipped) {
    insights.dealHealthSignals = dh.signals     || null;
    insights.competitorsFound  = dh.competitors || null;
    insights.healthScoreAfter  = dh.healthScore  || null;
    insights.healthStatusAfter = dh.healthStatus || null;
  }
  const re = results.rulesEngine;
  if (re && re.success) insights.actionsGenerated = re.actionsGenerated || 0;
  return insights;
}

function buildAiContext(category, content, options) {
  const base = { source: content.provider, fileName: content.fileName, dealId: options.dealId, contactId: options.contactId };
  switch (category) {
    case 'transcript': return { ...base, analysisType: 'meeting_transcript', extractActionItems: true, extractSentiment: true };
    case 'document': {
      const name = content.fileName.toLowerCase();
      if (name.includes('proposal'))                               return { ...base, analysisType: 'proposal' };
      if (name.includes('contract') || name.includes('agreement')) return { ...base, analysisType: 'contract' };
      return { ...base, analysisType: 'general_document' };
    }
    case 'email':   return { ...base, analysisType: 'email_thread' };
    default:        return { ...base, analysisType: 'general_document' };
  }
}

module.exports = { processStorageFile };
