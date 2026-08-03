// Roles & Access Control
export enum UserRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  AGENT = 'AGENT',
  VIEWER = 'VIEWER',
}

export enum IndustryType {
  HOSPITAL = 'HOSPITAL',
  CLINIC = 'CLINIC',
  HOTEL = 'HOTEL',
  RESTAURANT = 'RESTAURANT',
  SCHOOL = 'SCHOOL',
  UNIVERSITY = 'UNIVERSITY',
  CHURCH = 'CHURCH',
  LAW_FIRM = 'LAW_FIRM',
  REAL_ESTATE = 'REAL_ESTATE',
  LOGISTICS = 'LOGISTICS',
  BANK = 'BANK',
  INSURANCE = 'INSURANCE',
  GOVERNMENT = 'GOVERNMENT',
  SALON_SPA = 'SALON_SPA',
  SME = 'SME',
  ENTERPRISE = 'ENTERPRISE',
  OTHER = 'OTHER',
}

export enum ChannelType {
  VOICE = 'VOICE',
  WHATSAPP = 'WHATSAPP',
  WEBCHAT = 'WEBCHAT',
  SMS = 'SMS',
  EMAIL = 'EMAIL',
  INSTAGRAM = 'INSTAGRAM',
  TELEGRAM = 'TELEGRAM',
}

export enum CallDirection {
  INBOUND = 'INBOUND',
  OUTBOUND = 'OUTBOUND',
}

export enum CallStatus {
  QUEUED = 'QUEUED',
  RINGING = 'RINGING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  BUSY = 'BUSY',
  NO_ANSWER = 'NO_ANSWER',
}

export enum MessageSender {
  CUSTOMER = 'CUSTOMER',
  AI = 'AI',
  HUMAN_AGENT = 'HUMAN_AGENT',
  SYSTEM = 'SYSTEM',
}

export enum HandoffReason {
  LOW_CONFIDENCE = 'LOW_CONFIDENCE',
  CUSTOMER_REQUEST = 'CUSTOMER_REQUEST',
  TOOL_FAILURE = 'TOOL_FAILURE',
  COMPLEX_QUERY = 'COMPLEX_QUERY',
  URGENT_ESCALATION = 'URGENT_ESCALATION',
}

export enum BookingStatus {
  CONFIRMED = 'CONFIRMED',
  CANCELLED = 'CANCELLED',
  RESCHEDULED = 'RESCHEDULED',
  COMPLETED = 'COMPLETED',
  NO_SHOW = 'NO_SHOW',
}

export enum LeadStatus {
  NEW = 'NEW',
  CONTACTED = 'CONTACTED',
  QUALIFIED = 'QUALIFIED',
  UNQUALIFIED = 'UNQUALIFIED',
  CONVERTED = 'CONVERTED',
}

export enum DealStage {
  DISCOVERY = 'DISCOVERY',
  PROPOSAL = 'PROPOSAL',
  NEGOTIATION = 'NEGOTIATION',
  CLOSED_WON = 'CLOSED_WON',
  CLOSED_LOST = 'CLOSED_LOST',
}

export enum TicketStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  PENDING_CUSTOMER = 'PENDING_CUSTOMER',
  RESOLVED = 'RESOLVED',
  CLOSED = 'CLOSED',
}

export enum TicketPriority {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

export enum TelephonyProviderType {
  TWILIO = 'TWILIO',
  PLIVO = 'PLIVO',
  TELNYX = 'TELNYX',
  AFRICAS_TALKING = 'AFRICAS_TALKING',
  NIGERIA_CARRIER_FORWARD = 'NIGERIA_CARRIER_FORWARD',
  MTN_ENTERPRISE_SIP = 'MTN_ENTERPRISE_SIP',
  AIRTEL_BUSINESS_SIP = 'AIRTEL_BUSINESS_SIP',
}


// Telephony Interfaces
export interface CallInitiateOptions {
  organizationId: string;
  fromNumber: string;
  toNumber: string;
  provider: TelephonyProviderType;
  customMetadata?: Record<string, any>;
}

export interface CallTransferOptions {
  callId: string;
  targetPhoneNumber: string;
  agentId?: string;
  announceMessage?: string;
}

export interface CallRecord {
  callId: string;
  organizationId: string;
  from: string;
  to: string;
  direction: CallDirection;
  status: CallStatus;
  startTime: Date;
  endTime?: Date;
  durationSeconds?: number;
  recordingUrl?: string;
  transcript?: string;
  summary?: string;
  sentiment?: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
  provider: TelephonyProviderType;
}

// WhatsApp Interfaces
export interface WhatsAppMessagePayload {
  messageId: string;
  fromNumber: string;
  organizationId: string;
  messageType: 'text' | 'image' | 'audio' | 'document' | 'interactive' | 'location';
  textContent?: string;
  mediaUrl?: string;
  mediaMimeType?: string;
  timestamp: number;
}

// RAG / Knowledge Base Interfaces
export interface KnowledgeDocumentDTO {
  id: string;
  organizationId: string;
  title: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  status: 'PENDING' | 'PROCESSING' | 'INDEXED' | 'FAILED';
  chunkCount: number;
  createdAt: Date;
}

export interface SearchResultChunk {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
  metadata: Record<string, any>;
}

// Orchestrator Interfaces
export interface ConversationContext {
  conversationId: string;
  organizationId: string;
  customerPhoneNumber?: string;
  channel: ChannelType;
  history: Array<{
    sender: MessageSender;
    content: string;
    timestamp: Date;
    metadata?: Record<string, any>;
  }>;
  slots: Record<string, any>;
  currentIntent?: string;
  isHumanHandoffActive: boolean;
  assignedAgentId?: string;
}

export interface OrchestrationResult {
  replyText: string;
  audioUrl?: string;
  intentDetected?: string;
  confidenceScore: number;
  shouldHandoff: boolean;
  handoffReason?: HandoffReason;
  toolCallsExecuted?: Array<{ toolName: string; result: any }>;
}

// CRM Interfaces
export interface CustomerDTO {
  id: string;
  organizationId: string;
  fullName: string;
  email?: string;
  phoneNumber: string;
  companyName?: string;
  tags: string[];
  createdAt: Date;
}

export interface AppointmentDTO {
  id: string;
  organizationId: string;
  customerId: string;
  serviceName: string;
  startTime: Date;
  endTime: Date;
  status: 'CONFIRMED' | 'CANCELLED' | 'RESCHEDULED' | 'COMPLETED';
  notes?: string;
  staffName?: string;
}

export interface ReservationDTO {
  id: string;
  organizationId: string;
  customerId: string;
  partySize: number;
  reservationTime: Date;
  tableOrRoomNumber?: string;
  specialRequests?: string;
  status: 'CONFIRMED' | 'CANCELLED' | 'SEATED' | 'COMPLETED' | 'NO_SHOW';
}

// API User Session
export interface AuthUser {
  userId: string;
  organizationId: string;
  email: string;
  fullName: string;
  role: UserRole;
}
