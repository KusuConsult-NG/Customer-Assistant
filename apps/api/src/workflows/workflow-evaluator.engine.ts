import { AceLogger } from '../config/logger';

export interface WorkflowCondition {
  field: string;
  operator: 'EQUALS' | 'NOT_EQUALS' | 'CONTAINS' | 'GREATER_THAN' | 'LESS_THAN';
  value: any;
}

export interface WorkflowActionNode {
  id: string;
  type: 'SEND_WHATSAPP' | 'SEND_SMS' | 'CREATE_TASK' | 'UPDATE_DEAL_STAGE' | 'WEBHOOK_POST' | 'DELAY';
  config: Record<string, any>;
}

export interface WorkflowDefinition {
  id: string;
  organizationId: string;
  name: string;
  triggerEvent: 'LEAD_CREATED' | 'DEAL_STAGE_CHANGED' | 'CALL_ENDED' | 'MESSAGE_RECEIVED' | 'TICKET_CREATED' | 'BOOKING_CONFIRMED';
  conditions: WorkflowCondition[];
  actions: WorkflowActionNode[];
  isActive: boolean;
}

export class WorkflowEvaluatorEngine {
  private logger = new AceLogger('WorkflowEvaluatorEngine');

  /** Evaluates if a event payload meets workflow conditions */
  evaluateConditions(conditions: WorkflowCondition[], payload: Record<string, any>): boolean {
    if (!conditions || conditions.length === 0) return true;

    return conditions.every((cond) => {
      const fieldValue = this.getNestedValue(payload, cond.field);
      switch (cond.operator) {
        case 'EQUALS':
          return String(fieldValue) === String(cond.value);
        case 'NOT_EQUALS':
          return String(fieldValue) !== String(cond.value);
        case 'CONTAINS':
          return String(fieldValue || '').toLowerCase().includes(String(cond.value).toLowerCase());
        case 'GREATER_THAN':
          return Number(fieldValue) > Number(cond.value);
        case 'LESS_THAN':
          return Number(fieldValue) < Number(cond.value);
        default:
          return false;
      }
    });
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : null), obj);
  }
}
