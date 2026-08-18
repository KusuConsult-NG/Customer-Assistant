/**
 * One place to build an ElevenLabs client and one place to turn its failures
 * into ours.
 *
 * The error translation is the reason this is shared rather than copied. This
 * platform's rule is that a provider failure surfaces with the provider's own
 * reason attached — never a generic "something went wrong", and never a success
 * shape with empty fields. Two services calling the same API should not have
 * two different ideas of what a 422 means.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { ElevenLabsError } from '@elevenlabs/elevenlabs-js/errors';
import { decryptSecret } from '../common/secret-box';

@Injectable()
export class ElevenLabsApi {
  private readonly log = new Logger('ElevenLabsApi');

  /**
   * The workspace key to act as, for one organization.
   *
   * The tenant's own key is stored encrypted (see common/secret-box.ts) and is
   * decrypted here — in one place, so a caller cannot accidentally hand the
   * ciphertext to the SDK and get an authentication failure that looks like a
   * revoked key rather than a decryption problem.
   *
   * Falling back to ELEVENLABS_API_KEY means the shared workspace, which has no
   * tenancy boundary of its own. That is a real limitation, documented in
   * ElevenLabsNumbersService — not something to hide behind a default.
   */
  keyFor(organizationId: string, stored: string | null | undefined): string {
    if (stored) return decryptSecret(stored, `HostedAgentConfig.apiKey org=${organizationId}`);

    const shared = process.env.ELEVENLABS_API_KEY;
    if (shared) return shared;

    throw new BadRequestException(
      'No ElevenLabs API key is configured for this organization, and ELEVENLABS_API_KEY is unset.'
    );
  }

  /**
   * A client bound to one tenant's key.
   *
   * Built per call rather than cached: the key is per organization, and a
   * cached client keyed on nothing is how one tenant ends up making requests
   * against another tenant's workspace.
   */
  for(apiKey: string): ElevenLabsClient {
    // Data-residency deployments use a different host (api.eu.residency…,
    // api.in.residency…). Configurable so a tenant bound to a jurisdiction is
    // not silently routed through the default US endpoint.
    const baseUrl = process.env.ELEVENLABS_BASE_URL?.replace(/\/+$/, '');
    return new ElevenLabsClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
  }

  /** Rethrow a provider failure with the provider named and its reason kept. */
  fail(what: string, err: unknown): never {
    if (err instanceof ElevenLabsError) {
      const body = typeof err.body === 'string' ? err.body : JSON.stringify(err.body ?? {});
      this.log.error(
        `elevenlabs_error ${what} status=${err.statusCode} body=${body.slice(0, 400)}`
      );
      throw new ServiceUnavailableException(
        `ElevenLabs rejected ${what} (HTTP ${err.statusCode ?? '?'}): ${body.slice(0, 300)}`
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    this.log.error(`elevenlabs_unreachable ${what} error=${message}`);
    throw new ServiceUnavailableException(`Could not reach ElevenLabs for ${what}: ${message}`);
  }

  isNotFound(err: unknown): boolean {
    return err instanceof ElevenLabsError && err.statusCode === 404;
  }
}
