import { Module } from '@nestjs/common';
import { FilesController } from './files.controller';

/**
 * Signed downloads for files kept on this server (common/object-storage.ts).
 *
 * Deliberately NOT in a folder named `storage/`: .gitignore ignores every
 * `storage/` directory (Qdrant's local data), which silently left this module
 * out of the commit that introduced it — the tests passed against the files on
 * disk and CI failed on the import.
 */
@Module({ controllers: [FilesController] })
export class FilesModule {}
