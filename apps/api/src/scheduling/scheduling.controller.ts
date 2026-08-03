import {
  Controller, Get, Post, Patch, Body, Param, Req, UseGuards,
} from '@nestjs/common';
import { SchedulingService } from './scheduling.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthUser, BookingStatus } from '@ace/shared-types';

@Controller('api/scheduling')
@UseGuards(JwtAuthGuard)
export class SchedulingController {
  constructor(private schedulingService: SchedulingService) {}

  // ─── Bookings ─────────────────────────────────────────────────────────────────

  @Get('bookings')
  getBookings(@Req() req: { user: AuthUser }) {
    return this.schedulingService.getBookings(req.user.organizationId);
  }

  @Post('bookings')
  createBooking(
    @Req() req: { user: AuthUser },
    @Body() body: { contactId: string; serviceName: string; staffName?: string; startTime: string; notes?: string }
  ) {
    return this.schedulingService.createBooking(req.user.organizationId, body);
  }

  /**
   * Cancel a booking.
   * Body: { reason?: string }
   * The booking is marked CANCELLED and a note is attached.
   */
  @Patch('bookings/:id/cancel')
  cancelBooking(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { reason?: string }
  ) {
    return this.schedulingService.cancelBooking(req.user.organizationId, id, body.reason);
  }

  /**
   * Reschedule a booking to a new start time.
   * Body: { newStartTime: string (ISO 8601); durationMinutes?: number }
   */
  @Patch('bookings/:id/reschedule')
  rescheduleBooking(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { newStartTime: string; durationMinutes?: number }
  ) {
    return this.schedulingService.rescheduleBooking(
      req.user.organizationId,
      id,
      body.newStartTime,
      body.durationMinutes
    );
  }

  /**
   * Request a refund for a booking.
   * Creates a HIGH-priority support ticket with prefix REF-BK-*.
   * Also cancels the booking automatically so the slot is freed.
   * Body: { reason: string }
   */
  @Post('bookings/:id/refund-request')
  requestBookingRefund(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { reason: string }
  ) {
    return this.schedulingService.requestBookingRefund(
      req.user.organizationId,
      id,
      body.reason
    );
  }

  /** Legacy: direct status override (admin use). */
  @Patch('bookings/:id/status')
  updateBookingStatus(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { status: BookingStatus }) {
    return this.schedulingService.updateBookingStatus(id, body.status, req.user.organizationId);
  }

  // ─── Reservations ─────────────────────────────────────────────────────────────

  @Get('reservations')
  getReservations(@Req() req: { user: AuthUser }) {
    return this.schedulingService.getReservations(req.user.organizationId);
  }

  @Post('reservations')
  createReservation(
    @Req() req: { user: AuthUser },
    @Body() body: {
      contactId: string;
      partySize: number;
      reservationTime: string;
      tableOrRoomNumber?: string;
      specialRequests?: string;
    }
  ) {
    return this.schedulingService.createReservation(req.user.organizationId, body);
  }

  /**
   * Cancel a reservation.
   * Body: { reason?: string }
   */
  @Patch('reservations/:id/cancel')
  cancelReservation(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { reason?: string }
  ) {
    return this.schedulingService.cancelReservation(req.user.organizationId, id, body.reason);
  }

  /**
   * Reschedule a reservation to a new time.
   * Body: { newReservationTime: string (ISO 8601) }
   */
  @Patch('reservations/:id/reschedule')
  rescheduleReservation(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { newReservationTime: string }
  ) {
    return this.schedulingService.rescheduleReservation(
      req.user.organizationId,
      id,
      body.newReservationTime
    );
  }

  /**
   * Request a refund for a reservation.
   * Creates a HIGH-priority support ticket with prefix REF-RS-*.
   * Also cancels the reservation automatically.
   * Body: { reason: string }
   */
  @Post('reservations/:id/refund-request')
  requestReservationRefund(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { reason: string }
  ) {
    return this.schedulingService.requestReservationRefund(
      req.user.organizationId,
      id,
      body.reason
    );
  }

  // ─── Refund Queue (Admin) ──────────────────────────────────────────────────────

  /**
   * List all pending refund requests across bookings and reservations.
   * Filters tickets by REF-BK-* and REF-RS-* ticket number prefixes.
   * Only admins and owners should access this in production (enforced by RolesGuard).
   */
  @Get('refund-requests')
  getRefundRequests(@Req() req: { user: AuthUser }) {
    return this.schedulingService.getRefundRequests(req.user.organizationId);
  }
}
