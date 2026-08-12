import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHistoricalComparison,
  parseHistoricalComparisonArguments
} from "./historical-comparison.mjs";
import { resultStore } from "./result-store.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const defaultStaticRoot = path.join(projectRoot, "dashboard");
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]]
]);

function responseHeaders(contentType, cacheControl = "no-store") {
  return {
    "cache-control": cacheControl,
    "content-security-policy": "default-src 'self'; " +
      "script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff"
  };
}

function send(response, statusCode, body, contentType, method = "GET") {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  response.writeHead(statusCode, {
    ...responseHeaders(contentType),
    "content-length": buffer.length
  });
  response.end(method === "HEAD" ? undefined : buffer);
}

function sendJson(response, statusCode, value, method) {
  send(
    response,
    statusCode,
    `${JSON.stringify(value)}\n`,
    "application/json; charset=utf-8",
    method
  );
}

function apiErrorStatus(error) {
  if (/does not exist|not complete/i.test(error.message)) return 404;
  return 400;
}

function comparisonOptions(url) {
  const baseline = url.searchParams.get("baseline");
  if (!baseline) throw new Error("baseline query parameter is required.");
  const args = ["--baseline", baseline];
  const target = url.searchParams.get("target");
  const threshold = url.searchParams.get("threshold");
  if (target) args.push("--target", target);
  if (threshold !== null) args.push("--threshold", threshold);
  return parseHistoricalComparisonArguments(args);
}

export function parseDashboardArguments(args, environment = process.env) {
  let portSource = environment.LAB_DASHBOARD_PORT ?? "4173";
  if (args.length > 0) {
    if (args.length !== 2 || args[0] !== "--port" || !args[1]) {
      throw new Error("Usage: npm run dev -- --port <port>.");
    }
    portSource = args[1];
  }
  const port = /^\d+$/.test(portSource) ? Number(portSource) : Number.NaN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Dashboard port must be an integer between 1 and 65535.");
  }
  return { host: "127.0.0.1", port };
}

export function createDashboardRequestHandler(options = {}) {
  const store = options.store ?? resultStore;
  const staticRoot = options.staticRoot ?? defaultStaticRoot;
  const now = options.now;

  async function handle(request, response) {
    const method = request.method ?? "GET";
    if (!new Set(["GET", "HEAD"]).has(method)) {
      sendJson(response, 405, { error: "Read-only server: method not allowed." }, method);
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      if (url.pathname === "/api/latest") {
        sendJson(response, 200, await store.readLatestPointer(), method);
        return;
      }
      if (url.pathname === "/api/runs") {
        sendJson(
          response,
          200,
          await store.listRuns({ includeIncomplete: false }),
          method
        );
        return;
      }
      if (url.pathname.startsWith("/api/run/")) {
        const runId = decodeURIComponent(url.pathname.slice("/api/run/".length));
        const run = await store.readRun(runId);
        sendJson(response, 200, [run.manifest, run.benchmark, run.comparison], method);
        return;
      }
      if (url.pathname === "/api/compare") {
        const parsed = comparisonOptions(url);
        const [baselineRun, targetRun] = await Promise.all([
          store.readRun(parsed.baselineRunId),
          parsed.targetRunId
            ? store.readRun(parsed.targetRunId)
            : store.readLatestRun()
        ]);
        const comparison = createHistoricalComparison(baselineRun, targetRun, {
          thresholdPercent: parsed.thresholdPercent,
          ...(now ? { now } : {})
        });
        sendJson(response, 200, comparison, method);
        return;
      }
    } catch (error) {
      sendJson(response, apiErrorStatus(error), { error: error.message }, method);
      return;
    }

    const staticFile = staticFiles.get(url.pathname);
    if (!staticFile) {
      sendJson(response, 404, { error: "Not found." }, method);
      return;
    }
    try {
      const [filename, contentType] = staticFile;
      const body = await readFile(path.join(staticRoot, filename));
      send(response, 200, body, contentType, method);
    } catch (error) {
      sendJson(response, 500, { error: `Dashboard asset unavailable: ${error.message}` }, method);
    }
  }

  return (request, response) => {
    handle(request, response).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: error.message }, request.method);
      } else {
        response.destroy(error);
      }
    });
  };
}

export function startDashboardServer(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4173;
  const server = createServer(createDashboardRequestHandler(options));
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server);
    });
  });
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = parseDashboardArguments(process.argv.slice(2));
  await startDashboardServer(options);
  console.log(`Local dashboard: http://${options.host}:${options.port}`);
  console.log("Read-only mode: no benchmark or shell commands are exposed.");
}
