import { Module } from '@nestjs/common';
import { PlatformService } from './platform.service';
import { PlatformController } from './platform.controller';
import { OrganizationsModule } from '../organizations/organizations.module';

/**
 * Provisioning an agency invites its owner through `OrganizationsService`
 * rather than creating the user here: the invite path already issues a one-time
 * link, stores an unusable password hash and sends the email. A second
 * implementation would drift, and the drift would be in how an agency owner
 * first gets access.
 */
@Module({
  imports: [OrganizationsModule],
  providers: [PlatformService],
  controllers: [PlatformController],
})
export class PlatformModule {}
