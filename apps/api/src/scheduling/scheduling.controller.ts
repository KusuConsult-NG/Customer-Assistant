import {
  Controller, Get, Post, Patch, Body, Param, Req, UseGuards,
} from '@nestjs/common';
import { SchedulingService } from './scheduling.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser, BookingStatus } from '@ace/shared-types';
import { actorFrom } from '../common/actor';

/**
 * Appointments and reservations.
 *
 * ── Authorization, which this controller had none of ────────────────────────
 *
 * Every route here was open to every member, VIEWER included. A VIEWER could
 * cancel a citizen's clinic appointment, move it, override its status, and
 * raise a refund ticket against it. `getRefundRequests` even carried a comment
 * saying "Only admins and owners should access this in production (enforced by
 * RolesGuard)" — and no `RolesGuard` was applied, so the comment described a
 * protection that did not exist.
 *
 * `RolesGuard` has to be listed HERE, after `JwtAuthGuard`: it is not global
 * (Nest runs guards global → controller → route, so a global one would execute
 * before authentication populated `request.user`), and `@Roles` without it is
 * inert metadata that nothing reads.
 *
 * ── Why AGENT can write, where elsewhere only OWNER/ADMIN can ───────────────
 *
 * Moving or cancelling an appointment is routine front-desk work, and AGENT is
 * the front-desk role — an officer on a call to a citizen who cannot make
 * Tuesday needs to do this without escalating. Restricting it to OWNER/ADMIN
 * would push agencies towards sharing an admin account, which is worse than the
 * thing the restriction was protecting.
 *
 * Two things stay OWNER/ADMIN: the direct status override, which exists to
 * correct the record rather than to serve a citizen, and the refund QUEUE,
 * which is a cross-agency money view.
 */
@Controller('api/scheduling')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SchedulingController {
  constructor(private schedulingService: SchedulingService) {}

  // ─── Bookings ─────────────────────────────────────────────────────────────────

  @Get('bookings')
  getBookings(@Req() req: { user: AuthUser }) {
    return this.schedulingService.getBookings(req.user.organizationId);
  }

  @Roles('OWNER', 'ADMIN', 'AGENT')
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
  @Roles('OWNER', 'ADMIN', 'AGENT')
  @Patch('bookings/:id/cancel')
  cancelBooking(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { reason?: string }
  ) {
    return this.schedulingService.cancelBooking(req.user.organizationId, id, body.reason, actorFrom(req));
  }

  /**
   * Reschedule a booking to a new start time.
   * Body: { newStartTime: string (ISO 8601); durationMinutes?: number }
   */
  @Roles('OWNER', 'ADMIN', 'AGENT')
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
      body.durationMinutes,
      actorFrom(req)
    );
  }

  /**
   * Request a refund for a booking.
   * Creates a HIGH-priority support ticket with prefix REF-BK-*.
   * Also cancels the booking automatically so the slot is freed.
   * Body: { reason: string }
   */
  @Roles('OWNER', 'ADMIN', 'AGENT')
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
  @Roles('OWNER', 'ADMIN')
  @Patch('bookings/:id/status')
  updateBookingStatus(@Req() req: { user: AuthUser }, @Param('id') id: string, @Body() body: { status: BookingStatus }) {
    return this.schedulingService.updateBookingStatus(id, body.status, req.user.organizationId, actorFrom(req));
  }

  // ─── Reservations ─────────────────────────────────────────────────────────────

  @Get('reservations')
  getReservations(@Req() req: { user: AuthUser }) {
    return this.schedulingService.getReservations(req.user.organizationId);
  }

  @Roles('OWNER', 'ADMIN', 'AGENT')
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
  @Roles('OWNER', 'ADMIN', 'AGENT')
  @Patch('reservations/:id/cancel')
  cancelReservation(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { reason?: string }
  ) {
    return this.schedulingService.cancelReservation(req.user.organizationId, id, body.reason, actorFrom(req));
  }

  /**
   * Reschedule a reservation to a new time.
   * Body: { newReservationTime: string (ISO 8601) }
   */
  @Roles('OWNER', 'ADMIN', 'AGENT')
  @Patch('reservations/:id/reschedule')
  rescheduleReservation(
    @Req() req: { user: AuthUser },
    @Param('id') id: string,
    @Body() body: { newReservationTime: string }
  ) {
    return this.schedulingService.rescheduleReservation(
      req.user.organizationId,
      id,
      body.newReservationTime,
      actorFrom(req)
    );
  }

  /**
   * Request a refund for a reservation.
   * Creates a HIGH-priority support ticket with prefix REF-RS-*.
   * Also cancels the reservation automatically.
   * Body: { reason: string }
   */
  @Roles('OWNER', 'ADMIN', 'AGENT')
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
   *
   * OWNER/ADMIN, and now actually enforced: this comment used to say
   * "(enforced by RolesGuard)" on a controller that applied no RolesGuard.
   */
  @Roles('OWNER', 'ADMIN')
  @Get('refund-requests')
  getRefundRequests(@Req() req: { user: AuthUser }) {
    return this.schedulingService.getRefundRequests(req.user.organizationId);
  }
}
