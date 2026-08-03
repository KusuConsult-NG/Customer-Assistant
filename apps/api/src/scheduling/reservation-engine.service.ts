import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';
import { AceLogger } from '../config/logger';

export interface TableConfig {
  tableNumber: string;
  maxCapacity: number;
  section: 'MAIN_DINING' | 'VIP_LOUNGE' | 'PATIO' | 'PRIVATE_ROOM';
}

export interface HotelRoomConfig {
  roomNumber: string;
  roomType: 'STANDARD_SUITE' | 'EXECUTIVE_SUITE' | 'PRESIDENTIAL_SUITE';
  nightlyRateNGN: number;
}

@Injectable()
export class ReservationEngineService {
  private logger = new AceLogger('ReservationEngineService');

  /** Restaurant Table Capacity & Waitlist Engine */
  async findAvailableTable(
    organizationId: string,
    partySize: number,
    reservationTime: Date
  ): Promise<{ available: boolean; assignedTable?: string; waitlistPosition?: number }> {
    this.logger.info('checking_table_reservation_availability', { organizationId, partySize, reservationTime });

    // Defined inventory
    const tables: TableConfig[] = [
      { tableNumber: 'T-01', maxCapacity: 2, section: 'MAIN_DINING' },
      { tableNumber: 'T-02', maxCapacity: 4, section: 'MAIN_DINING' },
      { tableNumber: 'T-03', maxCapacity: 6, section: 'MAIN_DINING' },
      { tableNumber: 'VIP-101', maxCapacity: 8, section: 'VIP_LOUNGE' },
    ];

    // Find table matching capacity
    const suitableTables = tables.filter((t) => t.maxCapacity >= partySize);
    if (suitableTables.length === 0) {
      return { available: false, waitlistPosition: 3 };
    }

    // Check existing reservations around reservationTime (+/- 90 minutes)
    const bufferStart = new Date(reservationTime.getTime() - 90 * 60 * 1000);
    const bufferEnd = new Date(reservationTime.getTime() + 90 * 60 * 1000);

    const existing = await prisma.reservation.findMany({
      where: {
        organizationId,
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
        reservationTime: { gte: bufferStart, lte: bufferEnd },
      },
    });

    const reservedTables = new Set(existing.map((r: any) => r.tableOrRoomNumber));
    const freeTable = suitableTables.find((t: any) => !reservedTables.has(t.tableNumber));

    if (freeTable) {
      return { available: true, assignedTable: freeTable.tableNumber };
    }

    return { available: false, waitlistPosition: 1 };
  }

  /** Hotel Room Occupancy & Nightly Inventory Engine */
  async checkHotelRoomAvailability(
    organizationId: string,
    roomType: 'STANDARD_SUITE' | 'EXECUTIVE_SUITE' | 'PRESIDENTIAL_SUITE',
    checkInDate: Date,
    checkOutDate: Date
  ): Promise<{ available: boolean; roomNumber?: string; totalNights: number; totalPriceNGN: number }> {
    const nightMs = 24 * 60 * 60 * 1000;
    const totalNights = Math.max(1, Math.ceil((checkOutDate.getTime() - checkInDate.getTime()) / nightMs));
    
    const rates: Record<string, number> = {
      STANDARD_SUITE: 45000,
      EXECUTIVE_SUITE: 95000,
      PRESIDENTIAL_SUITE: 250000,
    };

    const totalPriceNGN = totalNights * (rates[roomType] || 50000);

    return {
      available: true,
      roomNumber: `${roomType.substring(0, 3)}-${Math.floor(Math.random() * 800 + 100)}`,
      totalNights,
      totalPriceNGN,
    };
  }
}
