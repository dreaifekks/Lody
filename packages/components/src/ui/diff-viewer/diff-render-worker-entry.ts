// Dedicated worker entry wrapper around `@pierre/diffs/worker/worker.js`.
// `@pierre/diffs/worker/worker.js` dynamically imports sibling highlighter chunks
// (e.g. `highlights-*.js`, `shiki-*.js`) that statically import `./worker.js`.
// Loading `@pierre/diffs/worker/worker.js?worker` directly causes Vite dev to
// evaluate two distinct module URLs (`?worker_file&type=module` vs `?v=...`)
// inside the same Worker, registering two `message` listeners where the second
// uninitialized copy throws `Theme "pierre-dark" has not been resolved`.
import '@pierre/diffs/worker/worker.js';
