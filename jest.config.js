export default {
  testEnvironment: 'node',
  globalSetup: '<rootDir>/tests/globalSetup.js',
  globalTeardown: '<rootDir>/tests/globalTeardown.js',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  testTimeout: 30000,
  collectCoverageFrom: ['src/**/*.js', '!src/server.js', '!src/config/swagger.js'],
  coverageThreshold: {
    './src/services/': { lines: 70, statements: 70, functions: 70, branches: 60 },
  },
};
