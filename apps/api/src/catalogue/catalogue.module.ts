import { Module } from '@nestjs/common';
import { CatalogueService } from './catalogue.service';
import { CatalogueController } from './catalogue.controller';

@Module({
  providers: [CatalogueService],
  controllers: [CatalogueController],
})
export class CatalogueModule {}
