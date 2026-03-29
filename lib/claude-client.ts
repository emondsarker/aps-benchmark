import Anthropic from '@anthropic-ai/sdk';
import type { ClaudeClassification, EnrichedDetection } from './types.ts';
import { warn } from './logger.ts';

const MODEL = 'claude-sonnet-4-20250514';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

function buildSystemPrompt(snifferName: string, snifferDescription: string): string {
  return `You are evaluating detections from "anti-pattern-sniffer" (aps), a regex-based static analysis tool for React, Express, and NestJS codebases.

You are reviewing detections from the "${snifferName}" sniffer.
Description: ${snifferDescription}

For each detection, classify as:
- TP (True Positive): The code genuinely exhibits this anti-pattern and would benefit from refactoring.
- FP (False Positive): The detection is wrong — the code is idiomatic, justified in context, or not actually problematic.
- Unclear: Cannot determine without broader project context.

For FP classifications, also categorize WHY it's a false positive:
- idiomatic-pattern: Standard React/Express/NestJS idiom that the tool misidentifies
- framework-api: Using a framework API as designed (e.g., component props matching a library interface)
- justified-complexity: The complexity is warranted by the requirements
- type-safe: TypeScript types make the pattern safe despite looking suspicious
- composition-not-drilling: Props are distributed across children, not drilled through
- threshold-too-low: The component/code is fine; the sniffer's numeric threshold is too aggressive
- other: None of the above — explain in reasoning

Respond ONLY with a JSON array. Each element:
{ "index": <number>, "classification": "TP" | "FP" | "Unclear", "fpCategory": "<category>" | null, "confidence": "high" | "medium" | "low", "reasoning": "<one concise sentence>" }

Be strict about FP classification: if the code is idiomatic, follows a well-known pattern, or the "anti-pattern" is actually the best approach in context, mark it FP.
For TP, set fpCategory to null.`;
}

function buildUserMessage(detections: EnrichedDetection[]): string {
  const parts = detections.map((d, i) => {
    return `[${i + 1}] File: ${d.relativeFilePath} (line ${d.line})
    Message: ${d.message}
    Severity: ${d.severity}${d.details ? `\n    Details: ${JSON.stringify(d.details)}` : ''}
    Code context:
\`\`\`
${d.sourceContext}
\`\`\``;
  });

  return `Detections to evaluate:\n\n${parts.join('\n\n')}`;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface BatchResult {
  classifications: ClaudeClassification[];
  promptTokens: number;
  completionTokens: number;
}

/**
 * Send a batch of detections to Claude for classification.
 */
export async function classifyBatch(
  detections: EnrichedDetection[],
  snifferName: string,
  snifferDescription: string,
): Promise<BatchResult> {
  const api = getClient();
  const systemPrompt = buildSystemPrompt(snifferName, snifferDescription);
  const userMessage = buildUserMessage(detections);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await api.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      const text = response.content
        .filter(block => block.type === 'text')
        .map(block => (block as { type: 'text'; text: string }).text)
        .join('');

      // Extract JSON from response (may be wrapped in markdown code blocks)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        throw new Error('No JSON array found in Claude response');
      }

      const classifications = JSON.parse(jsonMatch[0]) as ClaudeClassification[];

      return {
        classifications,
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      };
    } catch (e) {
      const msg = (e as Error).message || String(e);

      if (attempt < MAX_RETRIES && (msg.includes('rate_limit') || msg.includes('overloaded') || msg.includes('529'))) {
        warn(`  Rate limited, retrying in ${RETRY_DELAY_MS * attempt}ms (attempt ${attempt}/${MAX_RETRIES})...`);
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }

      throw e;
    }
  }

  throw new Error('Max retries exceeded');
}

/** Sniffer descriptions for the evaluation prompt */
export const SNIFFER_DESCRIPTIONS: Record<string, string> = {
  'prop-explosion': 'Detects React components that receive too many props, suggesting they should be refactored into smaller components or use composition patterns.',
  'prop-drilling': 'Detects components that accept props only to pass them unchanged to a child component, suggesting the need for React Context or composition.',
  'god-hook': 'Detects custom React hooks that manage too much state or have too many effects, suggesting they should be split into focused hooks.',
  'callback-hell': 'Detects deeply nested callback functions in Express middleware that reduce readability.',
  'god-routes': 'Detects Express route files that define too many routes, suggesting they should be split into focused routers.',
  'fat-controllers': 'Detects Express route handlers with too much logic that should be extracted into services.',
  'missing-error-handling': 'Detects Express async routes or middleware missing try/catch or error-handling middleware.',
  'no-input-validation': 'Detects Express routes that use req.body/req.params without input validation.',
  'hardcoded-secrets': 'Detects hardcoded API keys, tokens, passwords, and secrets in source code.',
  'god-service': 'Detects NestJS services with too many methods, suggesting they should be split.',
  'missing-dtos': 'Detects NestJS controller methods that don\'t use DTOs for request validation.',
  'business-logic-in-controllers': 'Detects NestJS controllers with business logic that should be in services.',
  'missing-guards': 'Detects NestJS controllers without authentication/authorization guards.',
  'magic-strings': 'Detects string literals used repeatedly in conditional logic that should be extracted to constants or enums.',
};

export function getModelName(): string {
  return MODEL;
}
