const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/**
 * Analyze email and extract actionable items
 */
async function analyzeEmail(emailData) {
  const prompt = `You are an AI assistant that analyzes emails and extracts actionable information for a CRM system.

Analyze the following email:

From: ${emailData.from?.emailAddress?.name || 'Unknown'} <${emailData.from?.emailAddress?.address || 'unknown@email.com'}>
Subject: ${emailData.subject || 'No Subject'}
Date: ${emailData.receivedDateTime || 'Unknown Date'}

Email Body:
${emailData.body?.content?.substring(0, 4000) || emailData.bodyPreview || 'No content'}

Extract the following information and respond ONLY with valid JSON (no markdown, no backticks):

{
  "action_items": [
    {
      "description": "Clear, actionable description",
      "deadline": "ISO 8601 date or null if not mentioned",
      "priority": "high|medium|low",
      "estimated_effort": "Brief estimate like '30 minutes' or '2 hours'"
    }
  ],
  "key_contacts": ["email@example.com or contact names"],
  "category": "Sales|Support|Meeting Request|Follow-up|Task|Information|Other",
  "sentiment": "positive|neutral|negative|urgent",
  "priority": "high|medium|low",
  "summary": "1-2 sentence summary of the email",
  "requires_response": true or false,
  "suggested_actions": ["Brief action suggestions"]
}

Important:
- Only include action_items if there are clear, specific tasks mentioned
- Set requires_response to true if the email expects a reply
- Estimate priority based on urgency indicators, deadlines, and sender importance
- Return valid JSON only, no other text`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      temperature: 0.3,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });
    
    const responseText = message.content[0].text;
    
    // Clean and parse JSON
    const cleanedText = responseText
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .trim();
    
    const analysis = JSON.parse(cleanedText);
    
    // Validate structure
    if (!analysis.action_items || !Array.isArray(analysis.action_items)) {
      analysis.action_items = [];
    }
    
    return analysis;
  } catch (error) {
    console.error('Claude analysis error:', error);
    
    // Return default structure on error
    return {
      action_items: [],
      key_contacts: [],
      category: 'Information',
      sentiment: 'neutral',
      priority: 'medium',
      summary: emailData.subject || 'Email analysis failed',
      requires_response: false,
      suggested_actions: [],
      error: error.message
    };
  }
}

/**
 * Batch analyze multiple emails
 */
async function analyzeEmailBatch(emails) {
  const results = [];
  
  for (const email of emails) {
    try {
      const analysis = await analyzeEmail(email);
      results.push({
        emailId: email.id,
        analysis,
        success: true
      });
      
      // Rate limiting - wait 1 second between requests
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      results.push({
        emailId: email.id,
        error: error.message,
        success: false
      });
    }
  }
  
  return results;
}

module.exports = {
  analyzeEmail,
  analyzeEmailBatch
};
