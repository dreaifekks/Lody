// Conversations a LAN publishes: the hub keeps the frozen copies and serves
// them on a listener of their own. This is what the hub, the agent service
// and the window agree on; none of it is a credential. See
// `.agents/docs/lan-sharing.md#shared-conversations`.
import { z } from 'zod';

export * from './lan-share-visible';

/** Management routes behind the hub's gate. */
export const LAN_SHARES_PATH = '/lan/shares';
export const LAN_SHARES_OBJECTS_PATH = '/lan/shares/objects';
export const LAN_SHARES_SETTINGS_PATH = '/lan/shares/settings';
/** `PUT` the bytes of an image of the share pages, `DELETE` to use Lody's again. */
export const LAN_SHARES_IMAGES_PATH = '/lan/shares/images';
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

/** A share as the window lists it: the share and the link it opens at. */
export const LanSharedConversationSchema = LanShareSchema.extend({
  url: z.string().nullable(),
}).strict();

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

/**
 * The images of a hub's share pages: the favicon, and the picture a link
 * preview shows. Either stays Lody's icon until a member sets one.
 */
export const LAN_SHARE_IMAGE_KINDS = ['icon', 'preview'] as const;
export const LanShareImageKindSchema = z.enum(LAN_SHARE_IMAGE_KINDS);
export type LanShareImageKind = z.infer<typeof LanShareImageKindSchema>;
export const LAN_SHARE_IMAGE_MAX_BYTES: Record<LanShareImageKind, number> = {
  icon: 256 * 1024,
  preview: 2 * 1024 * 1024,
};

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0) =>
  prefix.every((byte, index) => bytes[offset + index] === byte);
const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

/**
 * The type of an image of the share pages, read from its bytes and never from
 * a name: PNG, JPEG or WebP, and ICO for an icon. SVG is refused, since it can
 * carry script. `null` for anything else.
 */
export function sniffLanShareImage(bytes: Uint8Array, kind: LanShareImageKind): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  if (kind === 'icon' && startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  return null;
}

const LanShareImageSchema = z
  .object({ mediaType: z.string(), sizeBytes: z.number().int().nonnegative() })
  .strict();

/** The settings of a hub's share pages, as the hub answers `GET` of the settings route. */
export const LanShareHubSettingsSchema = z
  .object({
    publicUrl: z.string().nullable(),
    sharePort: z.number().int().min(1).max(65_535).nullable(),
    icon: LanShareImageSchema.nullable(),
    preview: LanShareImageSchema.nullable(),
  })
  .strict();
export type LanShareHubSettings = z.infer<typeof LanShareHubSettingsSchema>;

/** Those settings as the window shows them; no credential, and the addresses resolved. */
export const LanShareSettingsResultSchema = z
  .object({
    /** The address a member set; `null` when readers use the hub's own. */
    publicUrl: z.string().nullable(),
    /** The hub's own address on its share port; `null` when it serves no readers. */
    hubUrl: z.string().nullable(),
    icon: z.boolean(),
    preview: z.boolean(),
  })
  .strict();
export type LanShareSettingsResult = z.infer<typeof LanShareSettingsResultSchema>;

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
