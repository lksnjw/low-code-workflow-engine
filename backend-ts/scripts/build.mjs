import { build } from "esbuild";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const mode = process.argv[2];
if (mode !== "production" && mode !== "experiment") {
  throw new Error("build mode must be production or experiment");
}

const entry = resolve(mode === "production"
  ? "src/entrypoints/production.ts"
  : "packages/experiment/src/entrypoint.ts");
const outdir = resolve("dist", mode);
await mkdir(outdir, { recursive: true });
const entrySource = await readFile(entry, "utf8");

const localTypeScriptResolver = {
  name: "local-typescript-resolver",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^\.\.?\// }, (args) => {
      const requested = resolve(args.resolveDir, args.path);
      const candidate = requested.endsWith(".js")
        ? `${requested.slice(0, -3)}.ts`
        : requested;
      if (existsSync(candidate)) return { path: candidate };
      return undefined;
    });
    buildContext.onResolve({ filter: /.*/ }, (args) => {
      if (!args.path.startsWith(".") && !isAbsolute(args.path)) {
        return { path: args.path, external: true };
      }
      return undefined;
    });
  },
};

await build({
  absWorkingDir: process.cwd(),
  stdin: {
    contents: entrySource,
    loader: "ts",
    resolveDir: dirname(entry),
    sourcefile: basename(entry),
  },
  outfile: resolve(outdir, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  plugins: [localTypeScriptResolver],
  sourcemap: true,
  metafile: true,
  logLevel: "info",
  define: { "process.env.LCWE_BUILD_MODE": JSON.stringify(mode) },
}).then(async (result) => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(resolve(outdir, "meta.json"), JSON.stringify(result.metafile, null, 2) + "\n");
});
