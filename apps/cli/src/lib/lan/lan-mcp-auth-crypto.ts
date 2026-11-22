// Cryptographic primitives and wire protocol contracts for LAN Hub-hosted MCP
// authentication. Two domain-separated 256-bit keys are derived from the hub
// token via HKDF-SHA256: one for at-rest encryption of `mcp-auth.enc`, and one
// for AES-256-GCM wire envelopes carrying credentials over the LAN.
import crypto from 'node:crypto';
import { z } from 'zod';
import { McpStoredAuthenticationSchema } from '@/mcp/authentication/io';

export const LAN_MCP_AUTH_FILE_NAME = 'mcp-auth.enc';
export const LAN_HUB_MCP_AUTH_PREFIX = '/lan/mcp-auth/';
export const LAN_HUB_MCP_AUTH_STATUS_PATH = '/lan/mcp-auth/status';
export const LAN_HUB_MCP_AUTH_RECORDS_PREFIX = '/lan/mcp-auth/records/';
export const LAN_HUB_MCP_AUTH_TOKEN_PREFIX = '/lan/mcp-auth/token/';
export const LAN_HUB_MCP_AUTH_AUTHORIZE_CONFIG_PREFIX = '/lan/mcp-auth/authorize-config/';

export const LAN_MCP_AUTH_AT_REST_INFO = 'lody-lan-hub:mcp-auth-at-rest';
export const LAN_MCP_AUTH_WIRE_INFO = 'lody-lan-hub:mcp-auth-wire';
export const LAN_MCP_AUTH_ENVELOPE_VERSION = 1 as const;

const HKDF_SALT = Buffer.from('lody-lan-hub:mcp-auth:v1', 'utf8');
const IV_LENGTH_BYTES = 12;
const TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32;
const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type LanMcpAuthKeyPurpose = 'at-rest' | 'wire';

export const LanMcpAuthEnvelopeSchema = z
  .object({
    v: z.literal(LAN_MCP_AUTH_ENVELOPE_VERSION),
    iv: z.string().min(1),
    tag: z.string().min(1),
    ciphertext: z.string(),
  })
  .strict();
export type LanMcpAuthEnvelope = z.infer<typeof LanMcpAuthEnvelopeSchema>;

/** Derives a domain-separated 256-bit AES key from the LAN hub bearer token. */
export function deriveLanMcpAuthKey(hubToken: string, purpose: LanMcpAuthKeyPurpose): Buffer {
  if (!hubToken) {
    throw new Error('LAN hub token is required for MCP auth key derivation.');
  }
  const info = purpose === 'at-rest' ? LAN_MCP_AUTH_AT_REST_INFO : LAN_MCP_AUTH_WIRE_INFO;
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(hubToken, 'utf8'),
      HKDF_SALT,
      Buffer.from(info, 'utf8'),
      KEY_LENGTH_BYTES
    )
  );
}

/** Canonical AAD binding the envelope version and explicit usage/route context. */
export function buildLanMcpAuthAad(parts: readonly string[]): Buffer {
  return Buffer.from(JSON.stringify([`v=${LAN_MCP_AUTH_ENVELOPE_VERSION}`, ...parts]), 'utf8');
}

export function mcpAuthAtRestAad(): Buffer {
  return buildLanMcpAuthAad(['at-rest', LAN_MCP_AUTH_FILE_NAME]);
}

export function mcpAuthPutRecordRequestAad(serverId: string): Buffer {
  return buildLanMcpAuthAad(['wire', 'PUT', 'records', serverId, 'req']);
}

export function mcpAuthTokenRequestAad(serverId: string): Buffer {
  return buildLanMcpAuthAad(['wire', 'POST', 'token', serverId, 'req']);
}

/** SHA-256 digest of a canonical target JSON so `/status` never exposes expanded `${VAR}` values. */
export function hashLanMcpAuthTarget(target: string): string {
  return crypto.createHash('sha256').update(target, 'utf8').digest('hex');
}

export function mcpAuthTokenResponseAad(serverId: string): Buffer {
  return buildLanMcpAuthAad(['wire', 'POST', 'token', serverId, 'res']);
}

export function mcpAuthAuthorizeConfigRequestAad(serverId: string): Buffer {
  return buildLanMcpAuthAad(['wire', 'POST', 'authorize-config', serverId, 'req']);
}

export function mcpAuthAuthorizeConfigResponseAad(serverId: string): Buffer {
  return buildLanMcpAuthAad(['wire', 'POST', 'authorize-config', serverId, 'res']);
}

function decodeStrictBase64(value: string, label: string): Buffer {
  if (value.length % 4 !== 0 || !STRICT_BASE64.test(value)) {
    throw new Error(`Invalid base64 encoding in MCP auth envelope (${label}).`);
  }
  return Buffer.from(value, 'base64');
}

export function encryptLanMcpAuthJson(
  key: Buffer,
  aad: string | Buffer,
  payload: unknown
): LanMcpAuthEnvelope {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error('MCP auth encryption requires a 32-byte key.');
  }
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
    authTagLength: TAG_LENGTH_BYTES,
  });
  cipher.setAAD(typeof aad === 'string' ? Buffer.from(aad, 'utf8') : aad);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: LAN_MCP_AUTH_ENVELOPE_VERSION,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptLanMcpAuthJson(
  key: Buffer,
  aad: string | Buffer,
  envelopeInput: unknown
): unknown {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error('MCP auth decryption requires a 32-byte key.');
  }
  const envelope = LanMcpAuthEnvelopeSchema.parse(envelopeInput);
  const iv = decodeStrictBase64(envelope.iv, 'iv');
  const tag = decodeStrictBase64(envelope.tag, 'tag');
  if (iv.length !== IV_LENGTH_BYTES || tag.length !== TAG_LENGTH_BYTES) {
    throw new Error('Invalid MCP auth envelope IV or tag length.');
  }
  const ciphertext =
    envelope.ciphertext.length > 0
      ? decodeStrictBase64(envelope.ciphertext, 'ciphertext')
      : Buffer.alloc(0);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
    authTagLength: TAG_LENGTH_BYTES,
  });
  decipher.setAuthTag(tag);
  decipher.setAAD(typeof aad === 'string' ? Buffer.from(aad, 'utf8') : aad);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as unknown;
}

export const LanMcpAuthRefreshErrorSchema = z.enum(['expired', 'oauth_required']);
export type LanMcpAuthRefreshError = z.infer<typeof LanMcpAuthRefreshErrorSchema>;

/** Sanitized status metadata returned by `GET /lan/mcp-auth/status` and `PUT`. Never carries secrets. */
export const LanMcpAuthStatusItemSchema = z
  .object({
    mode: z.enum(['oauth', 'manual']),
    targetHash: z.string().regex(/^[0-9a-f]{64}$/),
    hasTokens: z.boolean(),
    hasRefreshToken: z.boolean(),
    hasCredentials: z.boolean(),
    expiresAt: z.number().optional(),
    hasClient: z.boolean(),
    revision: z.number().int().positive(),
    updatedAt: z.number().int().nonnegative(),
    refreshError: LanMcpAuthRefreshErrorSchema.optional(),
  })
  .strict();
export type LanMcpAuthStatusItem = z.infer<typeof LanMcpAuthStatusItemSchema>;

export const LanMcpAuthStatusResponseSchema = z
  .object({
    records: z.record(z.string(), LanMcpAuthStatusItemSchema),
  })
  .strict();
export type LanMcpAuthStatusResponse = z.infer<typeof LanMcpAuthStatusResponseSchema>;

export const LanMcpAuthPutRecordPayloadSchema = z
  .object({
    record: McpStoredAuthenticationSchema,
  })
  .strict();
export type LanMcpAuthPutRecordPayload = z.infer<typeof LanMcpAuthPutRecordPayloadSchema>;

export const LanMcpAuthPutRecordResponseSchema = LanMcpAuthStatusItemSchema.extend({
  serverId: z.string().min(1),
}).strict();
export type LanMcpAuthPutRecordResponse = z.infer<typeof LanMcpAuthPutRecordResponseSchema>;

export const LanMcpAuthDeleteRecordResponseSchema = z
  .object({
    removed: z.boolean(),
  })
  .strict();
export type LanMcpAuthDeleteRecordResponse = z.infer<typeof LanMcpAuthDeleteRecordResponseSchema>;

export const LanMcpAuthTokenRequestSchema = z
  .object({
    target: z.string().min(1),
    connectionUrl: z.string().url().optional(),
    forceRefresh: z.boolean().optional(),
    failedRevision: z.number().int().positive().optional(),
  })
  .strict();
export type LanMcpAuthTokenRequest = z.infer<typeof LanMcpAuthTokenRequestSchema>;

const StringRecordSchema = z.record(z.string(), z.string());

/** Strictly scoped token response: `refresh_token` and `client_secret` never leave the hub. */
export const LanMcpAuthTokenResponseSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('oauth'),
      headers: StringRecordSchema.refine((headers) => Boolean(headers.authorization), {
        message: 'OAuth token response requires an authorization header.',
      }),
      expiresAt: z.number().optional(),
      revision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('manual'),
      headers: StringRecordSchema.optional(),
      env: StringRecordSchema.optional(),
      revision: z.number().int().positive(),
    })
    .strict(),
]);
export type LanMcpAuthTokenResponse = z.infer<typeof LanMcpAuthTokenResponseSchema>;

export const LanMcpAuthAuthorizeConfigRequestSchema = z
  .object({
    target: z.string().min(1),
  })
  .strict();
export type LanMcpAuthAuthorizeConfigRequest = z.infer<
  typeof LanMcpAuthAuthorizeConfigRequestSchema
>;

/** Pre-registered/DCR OAuth client configuration for interactive browser authorization. Never carries tokens. */
export const LanMcpAuthAuthorizeConfigResponseSchema = z
  .object({
    clientId: z.string().max(2048).optional(),
    clientSecret: z.string().max(16_384).optional(),
    client: z
      .object({
        client_id: z.string(),
        client_secret: z.string().optional(),
        issuer: z.string().optional(),
        client_secret_expires_at: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type LanMcpAuthAuthorizeConfigResponse = z.infer<
  typeof LanMcpAuthAuthorizeConfigResponseSchema
>;

export const LanMcpAuthErrorResponseSchema = z.object({
  error: z.string().min(1),
});
