// The chat demo spawns processes, reads key files and spends an API key.
// It must only answer requests made to this machine, never a deployment.
//
// Three checks, because none is enough alone:
// - Host must be a loopback name. Blocks other machines and DNS rebinding.
// - Origin, when present, must be a loopback page. Blocks other websites
//   open in the same browser from posting to localhost.
// - POST bodies must be JSON, which forces a CORS preflight for cross-site
//   requests (and this server never answers preflights).
// The npm scripts also bind the server to 127.0.0.1.

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalHost(host: string | null): boolean {
  if (!host) return false;
  try {
    return LOCAL_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/** Returns a 403 response for anything that is not a local request, or null to continue. */
export function rejectNonLocal(request: Request): Response | null {
  const forbidden = (reason: string) =>
    Response.json({ error: `The chat demo only runs on localhost (${reason}). Start it with npm run dev.` }, { status: 403 });

  if (process.env.VERCEL) return forbidden("deployed");
  if (!isLocalHost(request.headers.get("host"))) return forbidden("host");
  const origin = request.headers.get("origin");
  if (origin && !isLocalOrigin(origin)) return forbidden("origin");
  if (request.method === "POST" && !request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "Send a JSON body." }, { status: 415 });
  }
  return null;
}
