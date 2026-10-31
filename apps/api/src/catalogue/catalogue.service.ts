import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma, PLATEAU_LGAS, resolveLga, recordAgencyAudit, type Actor } from '@ace/database';

/**
 * What an agency offers, and where — the editable side of the catalogue the
 * registration flow reads.
 *
 * ── Two rules this enforces, both about citizens rather than data hygiene ───
 *
 * An LGA must be one the State actually has. A location filed under "Jos
 * Northe" is unreachable: the flow resolves what a citizen says against the
 * State's list, finds nothing, and skips the question — so the office exists
 * in the dashboard and nowhere a citizen can be sent.
 *
 * A service must have a name a human would recognise, because that name is
 * what gets written on the record and read at a desk.
 *
 * ── On deleting ─────────────────────────────────────────────────────────────
 *
 * Nothing holds a foreign key to these: a registration stores the service and
 * location as NAMES in the contact's metadata, so removing a row never orphans
 * a citizen's record. A form somebody is part-way through is unaffected too —
 * the orchestrator seeded that conversation its own snapshot of the catalogue
 * before the first question, so it finishes with the options it started with.
 */
@Injectable()
export class CatalogueService {
  // ── Services ──────────────────────────────────────────────────────────────

  async listOptions(organizationId: string) {
    return prisma.serviceOption.findMany({
      where: { organizationId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createOption(organizationId: string, dto: OptionInput) {
    const data = this.cleanOption(dto);
    try {
      return await prisma.serviceOption.create({ data: { organizationId, ...data } });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException(`You already offer a service called "${data.name}".`);
      }
      throw e;
    }
  }

  async updateOption(organizationId: string, id: string, dto: Partial<OptionInput>) {
    await this.ownOption(organizationId, id);
    const patch = this.cleanOption(dto, true);
    try {
      return await prisma.serviceOption.update({ where: { id }, data: patch });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException(`You already offer a service called "${patch.name}".`);
      }
      throw e;
    }
  }

  async deleteOption(organizationId: string, id: string, actor: Actor) {
    const option = await this.ownOption(organizationId, id);
    await prisma.serviceOption.delete({ where: { id } });

    // A removed service stops being offered to citizens entirely, so the
    // record carries its name — the id resolves to nothing afterwards.
    await recordAgencyAudit(actor, organizationId, {
      action: 'agency.service.deleted',
      targetType: 'ServiceOption',
      targetId: id,
      previousValue: { name: option.name },
    });

    return { deleted: true };
  }

  // ── Locations ─────────────────────────────────────────────────────────────

  async listLocations(organizationId: string) {
    return prisma.serviceLocation.findMany({
      where: { organizationId },
      orderBy: [{ lga: 'asc' }, { name: 'asc' }],
    });
  }

  async createLocation(organizationId: string, dto: LocationInput) {
    const data = this.cleanLocation(dto);
    try {
      return await prisma.serviceLocation.create({ data: { organizationId, ...data } });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException(`You already have "${data.name}" in ${data.lga}.`);
      }
      throw e;
    }
  }

  async updateLocation(organizationId: string, id: string, dto: Partial<LocationInput>) {
    await this.ownLocation(organizationId, id);
    const patch = this.cleanLocation(dto, true);
    try {
      return await prisma.serviceLocation.update({ where: { id }, data: patch });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException('You already have a location with that name in that LGA.');
      }
      throw e;
    }
  }

  async deleteLocation(organizationId: string, id: string, actor: Actor) {
    const location = await this.ownLocation(organizationId, id);
    await prisma.serviceLocation.delete({ where: { id } });

    // The LGA too: the same office name can exist in several, so the name
    // alone does not say which row went.
    await recordAgencyAudit(actor, organizationId, {
      action: 'agency.location.deleted',
      targetType: 'ServiceLocation',
      targetId: id,
      previousValue: { name: location.name, lga: location.lga },
    });

    return { deleted: true };
  }

  /** The State's LGAs, so the editor offers them rather than taking free text. */
  lgas() {
    return { lgas: PLATEAU_LGAS };
  }

  // ── Scoping and validation ────────────────────────────────────────────────

  /**
   * Checked by a query that includes organizationId, not by reading the row
   * and comparing afterwards. There is no automatic tenant filter here, so a
   * `findUnique` by id alone would hand one agency another's row and the
   * comparison is a step somebody eventually forgets.
   */
  private async ownOption(organizationId: string, id: string) {
    const row = await prisma.serviceOption.findFirst({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('Service not found');
    return row;
  }

  private async ownLocation(organizationId: string, id: string) {
    const row = await prisma.serviceLocation.findFirst({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('Location not found');
    return row;
  }

  private cleanOption(dto: Partial<OptionInput>, partial = false) {
    const out: Record<string, unknown> = {};

    if (dto.name !== undefined || !partial) {
      const name = (dto.name ?? '').trim();
      if (name.length < 2) {
        throw new BadRequestException('A service needs a name a citizen would recognise.');
      }
      out.name = name;
    }
    if (dto.description !== undefined) {
      out.description = dto.description?.trim() || null;
    }
    if (dto.matchPhrases !== undefined) {
      if (!Array.isArray(dto.matchPhrases)) {
        throw new BadRequestException('matchPhrases must be a list of words.');
      }
      // Lowercased and de-duplicated here rather than at match time, so what
      // the agency sees in the editor is exactly what is compared against.
      out.matchPhrases = [
        ...new Set(dto.matchPhrases.map((p) => String(p).trim().toLowerCase()).filter(Boolean)),
      ];
    }
    if (dto.isNoCost !== undefined) out.isNoCost = Boolean(dto.isNoCost);
    if (dto.requiresReview !== undefined) out.requiresReview = Boolean(dto.requiresReview);
    if (dto.isActive !== undefined) out.isActive = Boolean(dto.isActive);
    if (dto.sortOrder !== undefined) {
      const n = Number(dto.sortOrder);
      if (!Number.isFinite(n)) throw new BadRequestException('sortOrder must be a number.');
      out.sortOrder = Math.trunc(n);
    }
    return out as any;
  }

  private cleanLocation(dto: Partial<LocationInput>, partial = false) {
    const out: Record<string, unknown> = {};

    if (dto.name !== undefined || !partial) {
      const name = (dto.name ?? '').trim();
      if (name.length < 2) {
        throw new BadRequestException('A location needs a name a citizen would recognise.');
      }
      out.name = name;
    }
    if (dto.lga !== undefined || !partial) {
      // Stored in the State's own spelling. Accepting "jos north" verbatim
      // would file the office under a string the flow never matches, so the
      // location would exist here and be unreachable in a conversation.
      const lga = resolveLga(dto.lga);
      if (!lga) {
        throw new BadRequestException(
          `"${dto.lga ?? ''}" is not a Plateau State LGA. One of: ${PLATEAU_LGAS.join(', ')}`
        );
      }
      out.lga = lga;
    }
    if (dto.kind !== undefined) out.kind = dto.kind?.trim() || null;
    if (dto.address !== undefined) out.address = dto.address?.trim() || null;
    if (dto.isActive !== undefined) out.isActive = Boolean(dto.isActive);
    return out as any;
  }
}

export interface OptionInput {
  name: string;
  description?: string;
  matchPhrases?: string[];
  isNoCost?: boolean;
  requiresReview?: boolean;
  isActive?: boolean;
  sortOrder?: number;
}

export interface LocationInput {
  name: string;
  lga: string;
  kind?: string;
  address?: string;
  isActive?: boolean;
}
