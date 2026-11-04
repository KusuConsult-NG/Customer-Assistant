import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';

/**
 * A test app configured the way `bootstrap()` configures the real one.
 *
 * `createNestApplication()` does NOT run `bootstrap()`, so none of what
 * `main.ts` installs is present unless a suite installs it too — and only one
 * suite did. Fifty-one of fifty-two therefore ran with NO global
 * `ValidationPipe`, which means:
 *
 *   - no suite but that one could prove any route's DTO validation holds. A
 *     `@MinLength(8)` on a password could be deleted and every one of them
 *     would still pass;
 *   - a suite that sent a deliberately invalid body and expected a 400 got a
 *     201 instead, and the honest reading of that is "the validation is
 *     missing in production" — which it is not. A harness that manufactures
 *     security findings is worse than one that misses them, because the next
 *     real one gets dismissed as another artefact.
 *
 * `rawBody` matters for the same reason: every carrier signature is verified
 * against the raw buffer, so without it a correctly signed request fails and
 * reads as a broken signature rather than a misconfigured test app.
 *
 * Suites that need to diverge should still call this and then override — the
 * point is that the DEFAULT matches production.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication({ rawBody: true });

  // Mirrors main.ts. Keep these in step: `forbidNonWhitelisted` is what makes
  // a payload with the wrong field names a 400 rather than a silently
  // discarded value.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    })
  );

  await app.init();
  return app;
}
