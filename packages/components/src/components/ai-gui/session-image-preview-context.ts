import { createContext } from 'react';

/**
 * The gallery of the conversation an image is shown in. `openImagePreview`
 * answers false when that gallery does not hold the image, which then opens alone.
 */
export const SessionImagePreviewContext = createContext<{
  openImagePreview: (imageKey: string) => boolean;
} | null>(null);
