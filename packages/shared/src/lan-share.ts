// Conversations a LAN publishes: the hub keeps the frozen copies and serves
// them on a listener of their own. This is what the hub, the agent service
// and the window agree on; none of it is a credential. See
// `.agents/docs/lan.md#shared-conversations`.
import { z } from 'zod';

/** Management routes behind the hub's gate. */
export const LAN_SHARES_PATH = '/lan/shares';
export const LAN_SHARES_OBJECTS_PATH = '/lan/shares/objects';
export const LAN_SHARES_SETTINGS_PATH = '/lan/shares/settings';
/** What a standby pulls to keep the shares with its copy of the hub. */
export const LAN_SHARES_COPY_PATH = '/lan/shares/copy';

/** 24 random bytes, base64url. */
export const LAN_SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
export const LanShareIdSchema = z.string().regex(LAN_SHARE_ID_PATTERN);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const SourceIdSchema = z.string().min(1).max(256);

export const LanShareSourceSchema = z
  .object({ sourceId: SourceIdSchema, conversationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/) })
  .strict();
export type LanShareSource = z.infer<typeof LanShareSourceSchema>;

/** A published share as its LAN's members manage it. */
export const LanShareSchema = z
  .object({
    shareId: LanShareIdSchema,
    title: z.string(),
    rootSourceId: SourceIdSchema,
    sources: z.array(LanShareSourceSchema),
    conversationCount: z.number().int().positive(),
    revision: z.number().int().positive(),
    deployment: Sha256Schema,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type LanShare = z.infer<typeof LanShareSchema>;

export const LanShareListSchema = z
  .object({
    shares: z.array(LanShareSchema),
    /** The port the hub serves readers on; `null` when it serves none. */
    sharePort: z.number().int().min(1).max(65_535).nullable(),
    /** Where readers reach that listener from outside, such as a tunnel. */
    publicUrl: z.string().nullable(),
  })
  .strict();
export type LanShareList = z.infer<typeof LanShareListSchema>;

/** Commits an uploaded package: a new share, or a new deployment of `shareId`. */
export const LanShareCommitSchema = z
  .object({
    shareId: LanShareIdSchema.optional(),
    /** The revision an update replaces; another update in between is refused. */
    expectedRevision: z.number().int().positive().optional(),
    rootSourceId: SourceIdSchema,
    sources: z.array(LanShareSourceSchema).min(1).max(64),
    manifest: z.unknown(),
  })
  .strict();
export type LanShareCommit = z.infer<typeof LanShareCommitSchema>;

export const LanShareSettingsSchema = z.object({ publicUrl: z.string().nullable() }).strict();

/** An http(s) address without a trailing slash, or `null` for none. */
export function normalizeLanSharePublicUrl(input: string | null): string | null {
  const trimmed = input?.trim();
  if (!trimmed) return null;
  const url = new URL(trimmed);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('A share address is an http or https address');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error('A share address carries no query, fragment or user');
  }
  return url.toString().replace(/\/+$/u, '');
}

/** Where readers open the shares of a hub: its public address, else the hub's host on the share port. */
export function resolveLanShareBaseUrl(
  hubUrl: string,
  list: Pick<LanShareList, 'sharePort' | 'publicUrl'>
): string | null {
  if (list.publicUrl) return list.publicUrl;
  if (list.sharePort === null) return null;
  const url = new URL(hubUrl);
  url.port = String(list.sharePort);
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/u, '');
}

export function formatLanShareUrl(baseUrl: string, shareId: string): string {
  return `${baseUrl}/s/${LanShareIdSchema.parse(shareId)}`;
}

/** A share as the window shows it: the link already resolved by the agent service. */
export type LanSharedConversation = LanShare & { url: string | null };

export type LanSharesResult = { shares: LanSharedConversation[] };
