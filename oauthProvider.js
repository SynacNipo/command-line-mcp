import { randomUUID } from "node:crypto";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const clients = new Map();
const codes = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();
const TOKEN_TTL_SECONDS = 3600;

function buildBaseUrl(req) {
  // When fronted by the Cloudflare Worker (or any reverse proxy), trust the
  // forwarded headers so metadata advertises the public URL, not localhost.
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return new URL(`${proto}://${host}`);
}

const clientsStore = {
  getClient(clientId) {
    return clients.get(clientId);
  },
  registerClient(client) {
    const clientId = randomUUID();
    const isPublic = client.token_endpoint_auth_method === "none";
    const full = {
      ...client,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
    };
    if (!isPublic) {
      full.client_secret = randomUUID();
    }
    clients.set(clientId, full);
    return full;
  },
};

export const provider = {
  clientsStore,

  async authorize(client, params, res) {
    const code = randomUUID();
    codes.set(code, {
      challenge: params.codeChallenge,
      clientId: client.client_id,
      scopes: params.scopes || [],
      redirectUri: params.redirectUri,
      resource: params.resource,
    });
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set("code", code);
    if (params.state) redirect.searchParams.set("state", params.state);
    res.redirect(302, redirect.href);
  },

  async challengeForAuthorizationCode(client, authorizationCode) {
    const entry = codes.get(authorizationCode);
    if (!entry) throw new InvalidGrantError("Invalid authorization code");
    return entry.challenge;
  },

  async exchangeAuthorizationCode(client, authorizationCode) {
    const entry = codes.get(authorizationCode);
    if (!entry) throw new InvalidGrantError("Invalid authorization code");
    codes.delete(authorizationCode);

    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;

    const authInfo = {
      token: accessToken,
      clientId: client.client_id,
      scopes: entry.scopes,
      expiresAt,
      resource: entry.resource,
    };
    accessTokens.set(accessToken, authInfo);
    refreshTokens.set(refreshToken, {
      clientId: client.client_id,
      scopes: entry.scopes,
      resource: entry.resource,
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: TOKEN_TTL_SECONDS,
      scope: entry.scopes.join(" "),
      refresh_token: refreshToken,
    };
  },

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const entry = refreshTokens.get(refreshToken);
    if (!entry) throw new InvalidGrantError("Invalid refresh token");
    refreshTokens.delete(refreshToken);

    const accessToken = randomUUID();
    const newRefreshToken = randomUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;

    const authInfo = {
      token: accessToken,
      clientId: client.client_id,
      scopes: scopes && scopes.length ? scopes : entry.scopes,
      expiresAt,
      resource: resource || entry.resource,
    };
    accessTokens.set(accessToken, authInfo);
    refreshTokens.set(newRefreshToken, {
      clientId: client.client_id,
      scopes: authInfo.scopes,
      resource: authInfo.resource,
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: TOKEN_TTL_SECONDS,
      scope: authInfo.scopes.join(" "),
      refresh_token: newRefreshToken,
    };
  },

  async verifyAccessToken(token) {
    const info = accessTokens.get(token);
    if (!info) throw new InvalidTokenError("Invalid access token");
    if (info.expiresAt && info.expiresAt < Math.floor(Date.now() / 1000)) {
      accessTokens.delete(token);
      throw new InvalidTokenError("Access token expired");
    }
    return info;
  },
};

export function authorizationServerMetadata(req) {
  const base = buildBaseUrl(req);
  return {
    issuer: base.href.replace(/\/$/, ""),
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    authorization_endpoint: new URL("/authorize", base).href,
    token_endpoint: new URL("/token", base).href,
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    scopes_supported: ["command-line"],
    registration_endpoint: new URL("/register", base).href,
    service_documentation: new URL("/health", base).href,
  };
}

export function protectedResourceMetadata(req) {
  const base = buildBaseUrl(req);
  return {
    resource: new URL("/mcp", base).href,
    authorization_servers: [base.href.replace(/\/$/, "")],
    scopes_supported: ["command-line"],
    resource_name: "Command-Line MCP",
  };
}
