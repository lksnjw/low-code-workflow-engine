import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { hostingBindings, generateHostingConfig } from "./hosting-config.mjs";
import { assertRelease, jsonHash } from "./hosting-artifact.mjs";
import presentationConfig from "../vite.presentation.config.js";

const cloud = { LCWE_FIREBASE_PROJECT_ID: "example-approved-project", VITE_API_BASE_URL: "https://backend.example.test/api", VITE_WS_BASE_URL: "wss://backend.example.test/ws" };
const local = { LCWE_HOSTING_EMULATOR: "1", VITE_API_BASE_URL: "http://127.0.0.1:8081/api", VITE_WS_BASE_URL: "ws://127.0.0.1:8081/ws" };
test("explicit Functions HTTP polling needs no fictitious WebSocket service", async () => {
  const env = { ...cloud, VITE_PROGRESS_TRANSPORT: "http-polling", VITE_WS_BASE_URL: undefined };
  const bindings = hostingBindings(env);
  assert.equal(bindings.config.wsBaseUrl, null);
  assert.equal(bindings.publicEnv.VITE_WS_BASE_URL, undefined);
  const base = JSON.parse(await readFile(new URL("../../firebase.json", import.meta.url), "utf8"));
  const config = generateHostingConfig(base, bindings);
  const csp = config.hosting.headers[0].headers.find(header => header.key === "Content-Security-Policy").value;
  assert.match(csp, /https:\/\/backend\.example\.test/);
  assert.doesNotMatch(csp, /wss?:/);
  assert.throws(() => hostingBindings({ ...env, VITE_WS_BASE_URL: "wss://backend.example.test/ws" }));
  assert.throws(() => hostingBindings({ ...env, VITE_PROGRESS_TRANSPORT: "unknown" }));
  assert.throws(() => hostingBindings({ ...env, VITE_API_BASE_URL: "http://127.0.0.1:8081/api" }));
});

test("explicit cloud and demo bindings are different release classes", () => {
  assert.equal(hostingBindings(cloud).emulatorOnly, false);
  assert.equal(hostingBindings(local).projectId, "demo-lcwe-hosting");
  // The upload page is visible by default in both release classes. This does
  // not grant upload access: the backend still enforces pipeline permissions.
  assert.equal(hostingBindings(local).config.pipelineUploadEnabled, true);
  assert.equal(hostingBindings(cloud).config.pipelineUploadEnabled, true);
  assert.equal(hostingBindings({ ...cloud, VITE_SENTRY_DSN: "" }).publicEnv.VITE_SENTRY_DSN, undefined);
});
test("the reviewed public timeout reaches hosting configuration without permitting unlimited waits", () => {
  const bindings = hostingBindings({ ...cloud, VITE_API_REQUEST_TIMEOUT_MS: "120000" });
  assert.equal(bindings.publicEnv.VITE_API_REQUEST_TIMEOUT_MS, "120000");
  assert.equal(bindings.config.apiRequestTimeoutMs, 120000);
  for (const value of ["0", "600000", "NaN"]) assert.throws(() => hostingBindings({ ...cloud, VITE_API_REQUEST_TIMEOUT_MS: value }));
});
for (const [name, patch] of Object.entries({ missingProject: { LCWE_FIREBASE_PROJECT_ID: "" }, missingApi: { VITE_API_BASE_URL: undefined }, missingWs: { VITE_WS_BASE_URL: undefined }, insecureApi: { VITE_API_BASE_URL: "http://backend.example.test/api" }, loopbackCloud: { VITE_API_BASE_URL: "http://127.0.0.1:8081/api" }, token: { VITE_WS_BASE_URL: "wss://backend.example.test/ws?secret=one" }, publicSecret: { VITE_ERP_API_KEY: "private" }, demoCloud: { LCWE_FIREBASE_PROJECT_ID: "demo-lcwe-hosting" }, wrongPath: { VITE_API_BASE_URL: "https://backend.example.test" } }))
  test(`${name} fails before build or network access`, () => assert.throws(() => hostingBindings({ ...cloud, ...patch })));
test("emulator builds cannot use any remote backend or real Firebase project", () => {
  assert.throws(() => hostingBindings({ ...local, VITE_API_BASE_URL: cloud.VITE_API_BASE_URL }));
  assert.throws(() => hostingBindings({ ...local, LCWE_FIREBASE_PROJECT_ID: cloud.LCWE_FIREBASE_PROJECT_ID }));
});
test("generated headers bind exact backend origins without credentials or wildcard CSP", async () => {
  const base = JSON.parse(await readFile(new URL("../../firebase.json", import.meta.url), "utf8"));
  const generated = generateHostingConfig(base, hostingBindings(cloud));
  assert.equal(generated.hosting.public, "public");
  assert.equal(base.hosting.public, "frontend/dist");
  const csp = generated.hosting.headers[0].headers.find(header => header.key === "Content-Security-Policy").value;
  assert.match(csp, /connect-src 'self' .* https:\/\/backend\.example\.test wss:\/\/backend\.example\.test;/);
  assert.equal(csp.includes("*"), false); assert.equal(csp.includes("'unsafe-eval'"), false);
});
test("RE2-compatible rewrite allowlist supports Windows and URL paths, not private/API namespaces", async () => {
  const base = JSON.parse(await readFile(new URL("../../firebase.json", import.meta.url), "utf8"));
  const pattern = new RegExp(base.hosting.rewrites[0].regex);
  for (const path of ["/", "/chat", "/dashboard", "/chat/session", "/settings/providers", "/profile/security", "/login"]) {
    assert.equal(pattern.test(path), true); assert.equal(pattern.test(path.replaceAll("/", "\\")), true);
  }
  for (const path of ["/api", "/api/missing", "/ws", "/assets/missing.js", "/.env", "/.git/config", "/activity", "/chatty", "/a-missing-screen"]) {
    assert.equal(pattern.test(path), false); assert.equal(pattern.test(path.replaceAll("/", "\\")), false);
  }
});
test("every declared protected frontend route has a permitted Hosting deep link", async () => {
  const base = JSON.parse(await readFile(new URL("../../firebase.json", import.meta.url), "utf8"));
  const source = await readFile(new URL("../src/config/router.jsx", import.meta.url), "utf8");
  const pattern = new RegExp(base.hosting.rewrites[0].regex);
  const routes = [...source.matchAll(/path:\s*"(\/[^"\n]*)"/g)]
    .map(match => match[1].replace(/:[A-Za-z]+/g, "saved-id"));
  assert.ok(routes.includes("/dashboard"));
  assert.ok(routes.length > 30);
  for (const route of routes) assert.equal(pattern.test(route), true, "Hosting route missing: " + route);
});
test("release guard rejects changed source/assets/config and wrong deployment identity", async () => {
  const base = JSON.parse(await readFile(new URL("../../firebase.json", import.meta.url), "utf8"));
  const bindings = hostingBindings(cloud), config = generateHostingConfig(base, bindings);
  const assets = { records: [{ path: "index.html", sha256: "fixture" }], totalBytes: 1, fingerprint: "fixture" };
  const manifest = { profile: "firebase-hosting-release/v1", bindings, configFingerprint: jsonHash(config), sourceFingerprint: "source", assets };
  const inputs = { manifest, config, base, assets, sourceFingerprint: "source", deployProject: cloud.LCWE_FIREBASE_PROJECT_ID };
  assert.deepEqual(assertRelease(inputs), bindings);
  assert.throws(() => assertRelease({ ...inputs, deployProject: "other-approved-project" }), /project does not match/);
  assert.throws(() => assertRelease({ ...inputs, sourceFingerprint: "changed" }), /Sources changed/);
  assert.throws(() => assertRelease({ ...inputs, assets: { ...assets, totalBytes: 2 } }), /files changed/);
  assert.throws(() => assertRelease({ ...inputs, config: { ...config, hosting: { ...config.hosting, public: "../backend-ts" } } }), /configuration changed/);
});
test("a verified demo artifact is still refused by the actual deployment guard", async () => {
  const base = JSON.parse(await readFile(new URL("../../firebase.json", import.meta.url), "utf8"));
  const bindings = hostingBindings(local), config = generateHostingConfig(base, bindings), assets = { records: [], totalBytes: 0, fingerprint: "fixture" };
  const manifest = { profile: "firebase-hosting-release/v1", bindings, configFingerprint: jsonHash(config), sourceFingerprint: "source", assets };
  const inputs = { manifest, config, base, assets, sourceFingerprint: "source" };
  assert.deepEqual(assertRelease(inputs), bindings);
  assert.throws(() => assertRelease({ ...inputs, deployProject: "demo-lcwe-hosting" }), /cannot be deployed/);
});
test("presentation runtime ignores owner env files and stays on the governed loopback proxy", () => {
  const config = presentationConfig({ command: "serve", mode: "presentation", isSsrBuild: false, isPreview: false });
  assert.equal(config.envDir, false);
  assert.equal(config.envPrefix, "LCWE_PRESENTATION_");
  assert.equal(config.server.host, "127.0.0.1");
  assert.equal(config.server.strictPort, true);
  assert.deepEqual(Object.keys(config.server.proxy), ["/api", "/ws"]);
  assert.equal(config.server.proxy["/api"].target, "http://localhost:8081");
  assert.equal(config.server.proxy["/ws"].target, "ws://localhost:8081");
});
test("development and container frontends cannot proxy directly to connector services", async () => {
  const files = await Promise.all([
    readFile(new URL("../vite.config.js", import.meta.url), "utf8"),
    readFile(new URL("../vite.presentation.config.js", import.meta.url), "utf8"),
    readFile(new URL("../nginx.conf.template", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
  ]);
  for (const source of files) {
    assert.doesNotMatch(source, /ERP_PIPELINE_API|azurewebsites|\/api\/pipeline/);
  }
  assert.match(files[0], /target: "http:\/\/localhost:8081"/);
  assert.match(files[2], /proxy_pass http:\/\/backend/);
});
