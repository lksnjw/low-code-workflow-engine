export default {
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".jsx"],
  transform: {
    "^.+\\.[jt]sx?$": "babel-jest",
  },
  setupFiles: ["<rootDir>/src/tests/setup.js"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "\\.css$": "<rootDir>/src/tests/__mocks__/styleMock.js",
  },
};
