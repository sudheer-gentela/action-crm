/**
 * Transcript Analyzer Service
 * Uses Claude API to extract insights from meeting transcripts
 */

const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../config/database');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Analyze meeting transcript and extract insights
 */
async function analyzeTranscript(transcriptId, userId) {
  const client = await pool.connect();
  
  try {
    console.log(`🤖 Starting AI analysis for transcript ${transcriptId}`);
    
    // Update status to analyzing
    await client.query(
      'UPDATE meeting_transcripts SET analysis_status = $1, updated_at = NOW() WHERE id = $2',
      ['analyzing', transcriptId]
    );
    
    // Get transcript and context
    const transcriptResult = await client.query(
      `SELECT 
        mt.*,
        d.name as deal_name,
        d.stage as deal_stage,
        d.value as deal_value,
        d.health as deal_health,
        acc.name as account_name,
        m.title as meeting_title
       FROM meeting_transcripts mt
       LEFT JOIN deals d ON mt.deal_id = d.id
       LEFT JOIN meetings m ON mt.meeting_id = m.id
       LEFT JOIN accounts acc ON d.account_id = acc.id
       WHERE mt.id = $1 AND mt.user_id = $2`,
      [transcriptId, userId]
    );
    
    if (transcriptResult.rows.length === 0) {
      throw new Error('Transcript not found');
    }
    
    const transcript = transcriptResult.rows[0];
    
    // Build context-aware prompt
    const prompt = buildAnalysisPrompt(transcript);
    
    // Call Claude API
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });
    
    // Parse Claude's response
    const analysisText = message.content[0].text;
    const analysis = parseAnalysisResponse(analysisText);
    
    console.log(`✅ AI analysis completed for transcript ${transcriptId}`);
    console.log(`   - Extracted ${analysis.actionItems?.length || 0} action items`);
    console.log(`   - Identified ${analysis.concerns?.length || 0} concerns`);
    
    // Store analysis results
    await client.query(
      `UPDATE meeting_transcripts 
       SET analysis_status = 'completed',
           analysis_result = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(analysis), transcriptId]
    );
    
    // Auto-create action items in CRM
    if (analysis.actionItems && analysis.actionItems.length > 0) {
      await createActionsFromInsights(client, userId, transcript.deal_id, analysis.actionItems);
    }
    
    // Update deal health if provided
    if (transcript.deal_id && analysis.dealHealthUpdate) {
      await updateDealHealth(client, transcript.deal_id, analysis.dealHealthUpdate);
    }
    
    return analysis;
    
  } catch (error) {
    console.error(`❌ Error analyzing transcript ${transcriptId}:`, error);
    
    await client.query(
      `UPDATE meeting_transcripts 
       SET analysis_status = 'failed',
           updated_at = NOW()
       WHERE id = $1`,
      [transcriptId]
    );
    
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Build context-aware prompt for Claude
 */
function buildAnalysisPrompt(transcript) {
  const dealContext = transcript.deal_name ? `
DEAL CONTEXT:
- Deal: ${transcript.deal_name}
- Stage: ${transcript.deal_stage}
- Value: $${transcript.deal_value}
- Health: ${transcript.deal_health}
- Account: ${transcript.account_name}
` : '';

  const meetingContext = transcript.meeting_title ? `
MEETING: ${transcript.meeting_title}
` : '';

  return `Analyze this sales meeting transcript and extract actionable insights.

${meetingContext}${dealContext}
TRANSCRIPT:
${transcript.transcript_text}

Extract and structure the following information:

1. **Summary**: A 2-3 sentence overview of the meeting
2. **Key Points**: Main discussion topics and decisions (bullet points)
3. **Customer Concerns**: Any objections, hesitations, or concerns raised
4. **Commitments Made**:
   - By us (sales team)
   - By customer
5. **Action Items**: Specific next steps with owner and due date
6. **Deal Health Signals**:
   - Positive indicators
   - Negative indicators  
   - Overall health assessment (healthy/watch/risk)
7. **Next Steps**: Recommended follow-up actions
8. **Questions Asked**: Important questions that need answers

Respond ONLY with a valid JSON object in this exact format:
{
  "summary": "Brief meeting summary",
  "keyPoints": ["point 1", "point 2"],
  "concerns": [
    {
      "concern": "description",
      "severity": "low/medium/high",
      "addressed": true/false
    }
  ],
  "commitments": {
    "us": ["commitment 1", "commitment 2"],
    "customer": ["commitment 1", "commitment 2"]
  },
  "actionItems": [
    {
      "description": "action description",
      "owner": "us/customer",
      "dueDate": "YYYY-MM-DD",
      "priority": "low/medium/high"
    }
  ],
  "dealHealthSignals": {
    "positive": ["signal 1", "signal 2"],
    "negative": ["signal 1", "signal 2"],
    "overallHealth": "healthy/watch/risk",
    "reasoning": "why this assessment"
  },
  "nextSteps": ["step 1", "step 2"],
  "questionsAsked": ["question 1", "question 2"],
  "confidence": 0.85
}

Extract realistic, specific information from the transcript. Do not make assumptions or add information not present in the text.`;
}

/**
 * Parse Claude's JSON response
 */
function parseAnalysisResponse(responseText) {
  try {
    // Try to find JSON in the response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    
    // If no JSON found, return error structure
    return {
      summary: 'Failed to parse AI response',
      error: 'Could not extract JSON from response',
      rawResponse: responseText
    };
  } catch (error) {
    console.error('Error parsing AI response:', error);
    return {
      summary: 'Failed to parse AI response',
      error: error.message,
      rawResponse: responseText
    };
  }
}

/**
 * Create actions in CRM from extracted action items
 */
async function createActionsFromInsights(client, userId, dealId, actionItems) {
  console.log(`📝 Creating ${actionItems.length} actions from meeting insights`);
  
  for (const item of actionItems) {
    // Only create actions for "us" (sales team)
    if (item.owner !== 'us') continue;
    
    try {
      const dueDate = item.dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // Default: 7 days
      const priorityMap = { low: 'low', medium: 'medium', high: 'high' };
      const priority = priorityMap[item.priority] || 'medium';
      
      await client.query(
        `INSERT INTO actions (
          user_id, deal_id, description, action_type, priority,
          due_date, status, source, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          userId,
          dealId,
          item.description,
          'follow_up', // Default type
          priority,
          dueDate,
          'pending',
          'meeting_transcript' // Mark source as transcript-generated
        ]
      );
      
      console.log(`   ✅ Created action: ${item.description}`);
    } catch (error) {
      console.error(`   ❌ Failed to create action:`, error.message);
    }
  }
}

/**
 * Update deal health based on AI assessment
 */
async function updateDealHealth(client, dealId, healthUpdate) {
  if (!healthUpdate || !healthUpdate.overallHealth) return;
  
  try {
    await client.query(
      'UPDATE deals SET health = $1, updated_at = NOW() WHERE id = $2',
      [healthUpdate.overallHealth, dealId]
    );
    
    console.log(`   ✅ Updated deal health to: ${healthUpdate.overallHealth}`);
  } catch (error) {
    console.error(`   ❌ Failed to update deal health:`, error.message);
  }
}

/**
 * Get analysis results for a transcript
 */
async function getTranscriptAnalysis(transcriptId, userId) {
  const result = await pool.query(
    `SELECT 
      mt.*,
      d.name as deal_name,
      m.title as meeting_title
     FROM meeting_transcripts mt
     LEFT JOIN deals d ON mt.deal_id = d.id
     LEFT JOIN meetings m ON mt.meeting_id = m.id
     WHERE mt.id = $1 AND mt.user_id = $2`,
    [transcriptId, userId]
  );
  
  return result.rows[0] || null;
}

module.exports = {
  analyzeTranscript,
  getTranscriptAnalysis
};
