const VIDEO_MIME_TYPES: Readonly<Record<string, string>> = {
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
};

const AUDIO_MIME_TYPES: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/ogg',
};

/** A container candidate; the browser still decides whether its codecs play. */
export function getVideoMimeTypeForPath(path: string): string | undefined {
  return getMimeTypeForPath(path, VIDEO_MIME_TYPES);
}

export function getAudioMimeTypeForPath(path: string): string | undefined {
  return getMimeTypeForPath(path, AUDIO_MIME_TYPES);
}

function getMimeTypeForPath(
  path: string,
  types: Readonly<Record<string, string>>
): string | undefined {
  const extension = /\.([^./\\]+)$/u.exec(path.split(/[?#]/u)[0] ?? '')?.[1]?.toLowerCase();
  return extension && Object.hasOwn(types, extension) ? types[extension] : undefined;
}
