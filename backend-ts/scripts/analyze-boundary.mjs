import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const metaPath = resolve("dist/production/meta.json");
let meta;
try {
  meta = JSON.parse(await readFile(metaPath, "utf8"));
} catch (error) {
  throw new Error(
    `could not read or parse production metafile: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}
const inputs = meta.inputs ?? {};
const validatorEntry = "src/validator/registry-validator.ts";
if (inputs[validatorEntry] === undefined)
  throw new Error(`${validatorEntry} is absent from the production artifact`);

const visited = new Set();
const pending = [validatorEntry];
while (pending.length > 0) {
  const current = pending.pop();
  if (visited.has(current)) continue;
  visited.add(current);
  for (const dependency of inputs[current]?.imports ?? []) {
    if (dependency.external !== true && inputs[dependency.path] !== undefined)
      pending.push(dependency.path);
  }
}

const forbiddenValidatorDependencies = [...visited].filter(
  (path) =>
    path.startsWith("src/http/") ||
    path.startsWith("src/analysisprovider/") ||
    path.startsWith("src/synthesizer/") ||
    path.startsWith("src/entrypoints/") ||
    path.startsWith("packages/experiment/"),
);
const productionExperimentInputs = Object.keys(inputs).filter((path) =>
  path.startsWith("packages/experiment/"),
);
const validatorSource = await readFile(resolve(validatorEntry), "utf8");
const transportSource = await readFile(
  resolve("src/tools/mcp-client.ts"),
  "utf8",
);
const sourceFiles = Object.keys(inputs).filter(
  (path) => path.startsWith("src/") && path.endsWith(".ts"),
);
const sdkImportPaths = [];
for (const path of sourceFiles) {
  const source = await readFile(resolve(path), "utf8");
  if (
    /from\s+["']@erpbridge\/sdk["']/.test(source) ||
    /import\s*\(\s*["']@erpbridge\/sdk["']\s*\)/.test(source)
  )
    sdkImportPaths.push(path);
}
const forbiddenSdkImports = sdkImportPaths.filter(
  (path) => path !== "src/tools/erpbridge-mcp-client.ts",
);
const capabilityConstructorExported =
  /export\s+(?:async\s+)?(?:function|const|class)\s+(?:mintCapability|mintValidationToken)\b/.test(
    validatorSource,
  );
const rawTransportExported =
  /export\s+(?:async\s+)?(?:function|const|class)\s+performHTTPRequest\b/.test(
    transportSource,
  );
const result = {
  metaPath,
  validatorEntry,
  validatorClosure: [...visited].sort(),
  forbiddenValidatorDependencies,
  productionExperimentInputs,
  sdkImportPaths,
  forbiddenSdkImports,
  capabilityConstructorExported,
  rawTransportExported,
  graphCoversResolvedStaticAndDynamicImports: true,
  passed:
    forbiddenValidatorDependencies.length === 0 &&
    productionExperimentInputs.length === 0 &&
    forbiddenSdkImports.length === 0 &&
    !capabilityConstructorExported &&
    !rawTransportExported,
};
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
