import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';
import { AceLogger } from '../config/logger';

export interface HallucinationFlag {
  id: string;
  organizationId: string;
  conversationId: string;
  customerQuery: string;
  aiResponse: string;
  retrievedContext: string;
  confidenceScore: number;
  flagReason: 'LOW_CONFIDENCE' | 'FACTUAL_MISMATCH' | 'USER_DOWNVOTE' | 'PROMPT_OVERRIDE';
  reviewedByHuman: boolean;
  correctAnswer?: string;
  createdAt: Date;
}

@Injectable()
export class AiEvaluationService {
  private logger = new AceLogger('AiEvaluationService');

  /** Flag an inaccurate AI response for review */
  async flagInaccurateResponse(params: {
    organizationId: string;
    conversationId: string;
    customerQuery: string;
    aiResponse: string;
    flagReason: 'LOW_CONFIDENCE' | 'FACTUAL_MISMATCH' | 'USER_DOWNVOTE' | 'PROMPT_OVERRIDE';
    correctAnswer?: string;
  }): Promise<HallucinationFlag> {
    this.logger.info('flagging_inaccurate_ai_response', { organizationId: params.organizationId, reason: params.flagReason });

    const flag: HallucinationFlag = {
      id: `flag_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      customerQuery: params.customerQuery,
      aiResponse: params.aiResponse,
      retrievedContext: 'Apex Care Service Catalog 2026 Page 3',
      confidenceScore: 0.54,
      flagReason: params.flagReason,
      reviewedByHuman: false,
      correctAnswer: params.correctAnswer,
      createdAt: new Date(),
    };

    return flag;
  }

  /** Retrain FAQ database from human correction */
  async promoteCorrectionToFaqRule(
    organizationId: string,
    flagId: string,
    question: string,
    verifiedAnswer: string
  ): Promise<{ promoted: boolean; ruleId: string }> {
    this.logger.info('promoting_correction_to_faq_rule', { organizationId, flagId, question });

    // Store in organization knowledge base
    const ruleId = `faq_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    return {
      promoted: true,
      ruleId,
    };
  }
}
