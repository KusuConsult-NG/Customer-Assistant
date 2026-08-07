/**
 * Jest config for the shared packages.
 *
 * These suites existed but no package declared a `test` script, so `npm test` never
 * ran them — and the telephony-sdk suite had been failing for some time unnoticed.
 * `turbo run test` now picks them up via the root `test` script.
 */
module.exports = {
  rootDir: 'packages',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.spec.ts'],
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: { esModuleInterop: true, strict: false } }],
  },
  moduleNameMapper: {
    '^@ace/shared-types$': '<rootDir>/shared-types/src/index.ts',
    '^@ace/database$': '<rootDir>/database/src/index.ts',
  },
};
