/**
 * Jest config for the shared packages, and for the scripts beside them.
 *
 * These suites existed but no package declared a `test` script, so `npm test` never
 * ran them — and the telephony-sdk suite had been failing for some time unnoticed.
 * `turbo run test` now picks them up via the root `test` script.
 *
 * `scripts/` is included for the same reason. The maintenance scripts edit real
 * things — credentials, contact records, the translation table — and a script
 * nothing tests is exactly the sort of code that is trusted because it once
 * worked. Root is the repository so both trees are reachable; the patterns are
 * explicit so nothing else gets swept in.
 */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/packages/**/test/**/*.spec.ts',
    '<rootDir>/scripts/**/*.spec.ts',
  ],
  transform: {
    // allowJs, because the scripts are plain JavaScript and their specs require
    // them directly. Without it ts-jest compiles them anyway and warns on every
    // run, which is how real warnings stop being read.
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: { esModuleInterop: true, strict: false, allowJs: true } }],
  },
  moduleNameMapper: {
    '^@ace/shared-types$': '<rootDir>/packages/shared-types/src/index.ts',
    '^@ace/database$': '<rootDir>/packages/database/src/index.ts',
  },
};
