import { ElevenLabsAgentService } from '../src/agent-tools/elevenlabs-agent.service';
import { prisma } from '@ace/database';

/**
 * Replacing an agent whose drift a sync cannot clear.
 *
 * The destructive repair, so the tests are about the cost being stated and
 * the attachments being carried across — not about the happy path.
 */
describe('recreating the ElevenLabs agent', () => {
  const makeService = (overrides: any = {}) => {
    // The API wrapper is never reached: `client` is stubbed below.
    const service: any = new ElevenLabsAgentService({} as any);
    service.tenant = jest.fn(async () => ({
      org: { id: 'org1', name: 'Agency' },
      config: {
        agentId: 'agent_old',
        whatsappPhoneNumberId: overrides.whatsappId ?? null,
        phoneNumberId: overrides.phoneNumberId ?? null,
      },
      apiKey: 'xi_key',
    }));
    service.client = jest.fn(() => overrides.client);
    service.syncAgent = jest.fn(async () => ({ agentId: 'agent_new', steps: [] }));
    return service;
  };

  const clientWith = (over: any = {}) => ({
    conversationalAi: {
      agents: { delete: over.deleteAgent ?? jest.fn(async () => ({})) },
      whatsappAccounts: { update: over.updateWhatsApp ?? jest.fn(async () => ({})) },
    },
  });

  it('refuses without an explicit confirmation, naming what changes', async () => {
    const service = makeService({ client: clientWith() });
    // Asserted on the message rather than the class: the point is that an
    // operator is told the agent id changes before anything is destroyed.
    await expect(service.recreateAgent('org1', {})).rejects.toThrow(/CHANGES ITS ID/);
    await expect(service.recreateAgent('org1', {})).rejects.toThrow(/confirmReplacesAgent/);
    expect(service.syncAgent).not.toHaveBeenCalled();
  });

  it('deletes, rebuilds, and reports the new id', async () => {
    const del = jest.fn(async () => ({}));
    const service = makeService({ client: clientWith({ deleteAgent: del }) });
    // Prisma is reached only to clear our own record of the old agent.
    jest.spyOn(prisma.hostedAgentConfig, 'update').mockResolvedValue({} as any);

    const r = await service.recreateAgent('org1', { confirmReplacesAgent: true });
    expect(del).toHaveBeenCalledWith('agent_old');
    expect(r.previousAgentId).toBe('agent_old');
    expect(r.agentId).toBe('agent_new');
    expect(r.deleted).toBe(true);
  });

  it('re-assigns an attached WhatsApp line to the new agent', async () => {
    const updateWhatsApp = jest.fn(async () => ({}));
    const service = makeService({ whatsappId: 'wa_line_1', client: clientWith({ updateWhatsApp }) });
    jest.spyOn(prisma.hostedAgentConfig, 'update').mockResolvedValue({} as any);

    const r = await service.recreateAgent('org1', { confirmReplacesAgent: true });
    expect(updateWhatsApp).toHaveBeenCalledWith('wa_line_1', { agentId: 'agent_new' });
    expect(r.restored.join(' ')).toContain('wa_line_1');
    expect(r.manualFollowUp).toHaveLength(0);
  });

  it('names the WhatsApp line as follow-up when re-assigning fails', async () => {
    const updateWhatsApp = jest.fn(async () => { throw new Error('line is not in this workspace'); });
    const service = makeService({ whatsappId: 'wa_line_1', client: clientWith({ updateWhatsApp }) });
    jest.spyOn(prisma.hostedAgentConfig, 'update').mockResolvedValue({} as any);

    const r = await service.recreateAgent('org1', { confirmReplacesAgent: true });
    // Silently leaving it would mean the line answers with a deleted agent.
    expect(r.restored).toHaveLength(0);
    expect(r.manualFollowUp.join(' ')).toContain('wa_line_1');
    expect(r.manualFollowUp.join(' ')).toContain('line is not in this workspace');
  });

  it('does NOT silently re-import a phone number, because that is the cutover', async () => {
    const service = makeService({ phoneNumberId: 'pn_1', client: clientWith() });
    jest.spyOn(prisma.hostedAgentConfig, 'update').mockResolvedValue({} as any);

    const r = await service.recreateAgent('org1', { confirmReplacesAgent: true });
    expect(r.manualFollowUp.join(' ')).toContain('confirmVoiceCutover');
  });

  it('treats an already-absent agent as done, not as a failure', async () => {
    const del = jest.fn(async () => { throw new Error('404 agent not found'); });
    const service = makeService({ client: clientWith({ deleteAgent: del }) });
    jest.spyOn(prisma.hostedAgentConfig, 'update').mockResolvedValue({} as any);

    const r = await service.recreateAgent('org1', { confirmReplacesAgent: true });
    // Refusing here would leave a tenant unable to recover from a deletion
    // made in the ElevenLabs dashboard.
    expect(r.deleted).toBe(true);
    expect(r.detail).toMatch(/already absent/i);
  });

  it('does not rebuild when ElevenLabs refuses the delete', async () => {
    const del = jest.fn(async () => { throw new Error('workspace is read-only'); });
    const service = makeService({ client: clientWith({ deleteAgent: del }) });
    await expect(service.recreateAgent('org1', { confirmReplacesAgent: true })).rejects.toThrow(
      /workspace is read-only/
    );
    expect(service.syncAgent).not.toHaveBeenCalled();
  });
});
