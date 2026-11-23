import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import { openSignedFile } from '../common/object-storage';

/**
 * Serves a file kept on this server's disk, to whoever holds a signed link.
 *
 * Deliberately NOT behind JwtAuthGuard: the dashboard opens these links in a
 * new tab (`window.open`) and in `<img src>`, neither of which can carry the
 * officer's bearer token. The LINK is the credential — minted by an endpoint
 * that is authenticated and tenant-scoped (`knowledge/documents/:id/download`,
 * `onboarding/selfie-requests/:id/image`), bound by HMAC to one bucket, one
 * path and one expiry, and refused once any of the three is changed. That is
 * the same contract Supabase's signed URLs gave, which is what these replace
 * on a server that keeps its own files.
 */
@Controller('api/files')
export class FilesController {
  @Get(':bucket/*')
  serve(
    @Param('bucket') bucket: string,
    @Req() req: Request,
    @Query('expires') expires: string | undefined,
    @Query('sig') sig: string | undefined,
    @Res() res: Response
  ) {
    const storagePath = String((req.params as any)[0] ?? '');
    const { file, contentType, fileName } = openSignedFile(bucket, storagePath, expires, sig);

    // Only an image is shown in the page; everything else is a download. A
    // stored .html or .svg rendered inline from the API's origin would run
    // whatever script it carries, and nosniff stops a browser guessing its way
    // round that.
    const inline = /^image\/(png|jpeg|webp|gif)$/.test(contentType);
    res.setHeader('Content-Type', inline ? contentType : 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}"`
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Referrer-Policy', 'no-referrer');
    // The dashboard may be on another origin and shows a selfie with <img>;
    // helmet's same-origin default would block it. The signature is the gate.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Content-Length', String(fs.statSync(file).size));
    fs.createReadStream(file).pipe(res);
  }
}
