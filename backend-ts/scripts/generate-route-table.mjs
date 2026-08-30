import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const source = resolve("fixtures/parity/http/route-wire-capture.json");
const target = resolve("src/http/generated-routes.ts");
const capture = JSON.parse(await readFile(source, "utf8"));
const routes = capture.routes.map(({ method, pattern }) => ({ method, path: pattern }));
if (routes.length !== 168) throw new Error(`expected 168 explicit routes, found ${routes.length}`);
const content = `// Generated from the live Go Fiber route graph. Do not hand-edit.\n` +
  `export const routeTable = ${JSON.stringify(routes, null, 2)} as const;\n` +
  `export type RouteDefinition = (typeof routeTable)[number];\n`;
await mkdir(dirname(target), { recursive: true });
await writeFile(target, content);
console.log(`generated ${routes.length} routes`);
