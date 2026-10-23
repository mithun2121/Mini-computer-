import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express from "express";

const pendingAuthorizations = new Map();
const authorizationCodes = new Map();
const loginFailures = new Map();
const MAX_CODE_AGE_MS = 2 * 60 * 1000;
const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

function b64url(input) { return Buffer.from(input).toString("base64url"); }
function randomId(bytes = 32) { return randomBytes(bytes).toString("base64url"); }
function secureEqual(a, b) {
  const x = Buffer.from(String(a || "")); const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
function publicOrigin() {
  const value = process.env.MINI_COMPUTER_PUBLIC_ORIGIN;
  if (!value) throw new Error("MINI_COMPUTER_PUBLIC_ORIGIN is not configured.");
  const u = new URL(value);
  if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) throw new Error("Public origin must use HTTPS.");
  return u.origin;
}
function oauthSecret() {
  const value = process.env.MINI_COMPUTER_OAUTH_SECRET;
  if (!value || value.length < 32) throw new Error("MINI_COMPUTER_OAUTH_SECRET must be at least 32 characters.");
  return value;
}
function clientIdFor(redirectUri) { return b64url(createHash("sha256").update(`mini-computer-client-v1\n${redirectUri}`).digest()); }
function signJwt(claims) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const input = `${header}.${payload}`;
  const signature = createHmac("sha256", oauthSecret()).update(input).digest("base64url");
  return `${input}.${signature}`;
}
export function verifyAccessToken(token, expectedUse = "access") {
  try {
    const parts = String(token || "").split("."); if (parts.length !== 3) return null;
    const input = `${parts[0]}.${parts[1]}`;
    const expected = createHmac("sha256", oauthSecret()).update(input).digest();
    const actual = Buffer.from(parts[2], "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const origin = publicOrigin();
    if (header.alg !== "HS256" || claims.iss !== origin || claims.aud !== origin || !Number.isFinite(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000) || claims.token_use !== expectedUse) return null;
    if (typeof claims.scope !== "string") return null;
    return claims;
  } catch { return null; }
}

export function registerOAuthRoutes(app) {
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    const origin = publicOrigin();
    res.json({ resource: origin, authorization_servers: [origin], bearer_methods_supported: ["header"], scopes_supported: ["files:read", "files:write", "terminal:execute", "offline_access"] });
  });
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    const origin = publicOrigin();
    res.json({ issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`, response_types_supported: ["code"], response_modes_supported: ["query"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["files:read", "files:write", "terminal:execute", "offline_access"] });
  });
  app.post("/oauth/register", (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length !== 1) return res.status(400).json({ error: "invalid_client_metadata" });
    const redirects = [];
    for (const raw of body.redirect_uris) {
      let u; try { u = new URL(raw); } catch { return res.status(400).json({ error: "invalid_redirect_uri" }); }
      if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) return res.status(400).json({ error: "invalid_redirect_uri" });
      redirects.push(u.href);
    }
    const clientId = clientIdFor(redirects[0]);
    res.status(201).json({ client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: redirects, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
  });
  app.get("/oauth/authorize", (req, res) => {
    try {
      const origin = publicOrigin();
      const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope, resource } = req.query;
      if (response_type !== "code" || typeof redirect_uri !== "string" || typeof client_id !== "string" || clientIdFor(new URL(redirect_uri).href) !== client_id) return res.status(400).send("Invalid OAuth client or redirect URI.");
      const redirect = new URL(redirect_uri);
      if (redirect.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(redirect.hostname)) return res.status(400).send("HTTPS redirect URI required.");
      if (typeof code_challenge !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(code_challenge) || code_challenge_method !== "S256") return res.status(400).send("PKCE S256 is required.");
      if (typeof state !== "string" || state.length < 8 || state.length > 512) return res.status(400).send("OAuth state is required.");
      if (resource !== origin) return res.status(400).send("The OAuth resource parameter must match this MCP server's HTTPS origin.");
      const requestedScopes = String(scope || "files:read").split(/\s+/).filter(Boolean);
      if (!requestedScopes.length || requestedScopes.some((s) => !["files:read", "files:write", "terminal:execute", "offline_access"].includes(s))) return res.status(400).send("Unsupported OAuth scope.");
      const nonce = randomId(24);
      pendingAuthorizations.set(nonce, { client_id: client_id, redirect_uri: redirect.href, code_challenge, state, scopes: requestedScopes, resource, created: Date.now() });
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mini Computer authorization</title><style>body{font:16px system-ui;max-width:440px;margin:10vh auto;padding:24px}input{box-sizing:border-box;width:100%;padding:12px;margin:8px 0 16px}button{padding:12px 18px;width:100%}</style></head><body><h1>Authorize Mini Computer</h1><p>Sign in to allow ChatGPT to use your Mini Computer tools. Grant access only if you initiated this connection.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="nonce" value="${nonce}"><label>Username</label><input name="username" autocomplete="username" required><label>Password</label><input name="password" type="password" autocomplete="current-password" required><button type="submit">Sign in and authorize</button></form></body></html>`;
      res.type("html").send(html);
    } catch (e) { res.status(500).send(e.message || "OAuth configuration error."); }
  });
  app.post("/oauth/authorize", expressUrlEncoded(), (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const attempt = loginFailures.get(ip);
    if (attempt && Date.now() - attempt.started < 15 * 60 * 1000 && attempt.count >= 10) return res.status(429).send("Too many sign-in attempts. Wait 15 minutes and try again.");

    const nonce = req.body?.nonce;
    const tx = pendingAuthorizations.get(nonce);
    if (!tx || Date.now() - tx.created > 10 * 60 * 1000) { pendingAuthorizations.delete(nonce); return res.status(400).send("Authorization request expired. Start again from ChatGPT."); }
    pendingAuthorizations.delete(nonce);
    if (!process.env.MINI_COMPUTER_OAUTH_USERNAME || !process.env.MINI_COMPUTER_OAUTH_PASSWORD) return res.status(503).send("OAuth username/password are not configured by the server owner.");
    if (!secureEqual(req.body.username, process.env.MINI_COMPUTER_OAUTH_USERNAME) || !secureEqual(req.body.password, process.env.MINI_COMPUTER_OAUTH_PASSWORD)) {
      const now = Date.now(); const current = loginFailures.get(ip);
      if (!current || now - current.started >= 15 * 60 * 1000) loginFailures.set(ip, { started: now, count: 1 }); else current.count += 1;
      return res.status(401).send("Invalid username or password. Return to ChatGPT and try again.");
    }
    loginFailures.delete(ip);
    const code = randomId(32);
    authorizationCodes.set(code, { ...tx, created: Date.now() });
    const redirect = new URL(tx.redirect_uri); redirect.searchParams.set("code", code); redirect.searchParams.set("state", tx.state);
    res.redirect(302, redirect.href);
  });
  app.post("/oauth/token", (req, res) => {
    const body = req.body || {};
    if (body.grant_type === "refresh_token") {
      const refresh = verifyAccessToken(body.refresh_token, "refresh");
      if (!refresh || body.resource !== publicOrigin()) return res.status(400).json({ error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000);
      try {
        const access = signJwt({ iss: publicOrigin(), aud: publicOrigin(), sub: refresh.sub, iat: now, exp: now + ACCESS_TOKEN_SECONDS, scope: refresh.scope, token_use: "access" });
        return res.set("Cache-Control", "no-store").set("Pragma", "no-cache").json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: body.refresh_token, scope: refresh.scope });
      } catch (e) { return res.status(500).json({ error: "server_error", error_description: e.message }); }
    }
    if (body.grant_type !== "authorization_code" || typeof body.code !== "string" || typeof body.code_verifier !== "string" || typeof body.client_id !== "string" || typeof body.redirect_uri !== "string") return res.status(400).json({ error: "invalid_request" });
    const code = authorizationCodes.get(body.code); authorizationCodes.delete(body.code);
    if (!code || Date.now() - code.created > MAX_CODE_AGE_MS || code.client_id !== body.client_id || code.redirect_uri !== body.redirect_uri || clientIdFor(new URL(body.redirect_uri).href) !== body.client_id) return res.status(400).json({ error: "invalid_grant" });
    const challenge = createHash("sha256").update(body.code_verifier).digest("base64url");
    if (!secureEqual(challenge, code.code_challenge)) return res.status(400).json({ error: "invalid_grant" });
    if (body.resource !== code.resource || body.resource !== publicOrigin()) return res.status(400).json({ error: "invalid_target" });
    const now = Math.floor(Date.now() / 1000);
    let token; try { token = signJwt({ iss: publicOrigin(), aud: publicOrigin(), sub: "mini-computer-owner", iat: now, exp: now + ACCESS_TOKEN_SECONDS, scope: code.scopes.join(" "), token_use: "access" }); }
    catch (e) { return res.status(500).json({ error: "server_error", error_description: e.message }); }
    const refreshToken = signJwt({ iss: publicOrigin(), aud: publicOrigin(), sub: "mini-computer-owner", iat: now, exp: now + REFRESH_TOKEN_SECONDS, scope: code.scopes.join(" "), token_use: "refresh" });
    res.set("Cache-Control", "no-store").set("Pragma", "no-cache").json({ access_token: token, token_type: "Bearer", expires_in: ACCESS_TOKEN_SECONDS, refresh_token: refreshToken, scope: code.scopes.join(" ") });
  });
}

function expressUrlEncoded() { return express.urlencoded({ extended: false, limit: "16kb" }); }
