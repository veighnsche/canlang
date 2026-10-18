/** Protected gallery previews; the server remains the authority for every GET. */
import type { ClientInternals, ComponentBinder, ElementLike, EventLike } from './bootstrap.js';

export interface ImageFetchInit {
  readonly method: 'GET'; readonly cache: 'no-store'; readonly credentials: 'same-origin';
  readonly mode: 'same-origin'; readonly redirect: 'error'; readonly signal: AbortSignal;
}
export interface ImageResponse {
  readonly status: number; readonly redirected?: boolean;
  readonly headers: { get(name: string): string | null };
  blob(): Promise<Blob>;
}
export type ImageFetch = (url: string, init: ImageFetchInit) => Promise<ImageResponse>;
interface GalleryImage extends ElementLike { decode(): Promise<void>; readonly complete?: boolean; readonly naturalWidth?: number }
interface GalleryDialog extends ElementLike { readonly open: boolean; showModal(): void; close(): void }
interface GalleryElement extends ElementLike { readonly parentElement?: GalleryElement | null }
interface StatusElement extends ElementLike { textContent: string | null }

function protectedUrl(value: string | null, internals: ClientInternals): string {
  const base = internals.windowRef.location.href;
  if (value === null || value === '' || base === undefined || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value)) throw new TypeError('Invalid gallery URL.');
  const current = new URL(base), url = new URL(value, current);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== current.origin ||
      url.username !== '' || url.password !== '' || value.includes('#')) throw new TypeError('Invalid gallery URL.');
  return url.href;
}

/** Attempt every owned release and preserve the first thrown value. */
function releaseGalleryResources(releases: readonly (() => void)[]): void {
  let failure: { value: unknown } | undefined;
  for (const release of releases) {
    try { release(); } catch (value) { failure ??= { value }; }
  }
  if (failure !== undefined) throw failure.value;
}

function galleryElements(root: ElementLike): {
  dialog: GalleryDialog; image: GalleryImage; state: StatusElement; original: ElementLike;
} | undefined {
  const dialog = root.querySelector?.('[data-can-gallery-dialog]') as GalleryDialog | null | undefined;
  const image = root.querySelector?.('[data-can-gallery-image]') as GalleryImage | null | undefined;
  const state = root.querySelector?.('[data-can-gallery-state]') as StatusElement | null | undefined;
  const original = root.querySelector?.('[data-can-gallery-preview-original]');
  if (dialog == null || image == null || state == null || original == null ||
      typeof dialog.showModal !== 'function' || typeof dialog.close !== 'function' || typeof image.decode !== 'function') return undefined;
  return { dialog, image, state, original };
}

function checkPreviewResponse(response: ImageResponse): void {
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300 || response.redirected === true ||
      (type !== 'image/png' && type !== 'image/jpeg')) throw new Error('Gallery preview refused.');
}

export const bindGallery: ComponentBinder = (root, client, internals) => {
  const elements = galleryElements(root);
  if (elements === undefined) return () => {};
  const { dialog, image, state, original } = elements;
  const context = client.contextKey();
  const loading = root.getAttribute('data-can-gallery-loading') ?? '';
  const error = root.getAttribute('data-can-gallery-error') ?? '';
  const listeners: Array<readonly [ElementLike, string, (event: EventLike) => void, boolean]> = [];
  let stopped = false, version = 0, controller: AbortController | undefined, objectUrl: string | undefined;
  let opener: ElementLike | undefined;
  const connected = () => !stopped && root.isConnected && dialog.isConnected && image.isConnected && client.contextKey() === context;
  const invalidate = () => {
    version++;
    const pending = controller, url = objectUrl; controller = undefined; objectUrl = undefined;
    releaseGalleryResources([
      () => pending?.abort(),
      () => image.setAttribute('hidden', ''), () => image.setAttribute('alt', ''), () => image.removeAttribute('src'),
      () => original.setAttribute('hidden', ''), () => original.removeAttribute('href'),
      () => { if (url !== undefined) URL.revokeObjectURL(url); },
    ]);
  };
  const close = () => {
    const previous = opener; opener = undefined;
    releaseGalleryResources([
      invalidate, () => { state.textContent = ''; },
      () => { if (dialog.open) dialog.close(); },
      () => { if (previous?.isConnected) previous.focus(); },
    ]);
  };
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    releaseGalleryResources([close, ...listeners.splice(0).map(([element, type, listener, capture]) => () => {
      (element as ElementLike & { removeEventListener(type: string, listener: (event: EventLike) => void, capture: boolean): void }).removeEventListener(type, listener, capture);
    })]);
  };
  const listen = (element: ElementLike, type: string, listener: (event: EventLike) => void, capture = false) => {
    listeners.push([element, type, listener, capture]);
    (element as ElementLike & { addEventListener(type: string, listener: (event: EventLike) => void, capture: boolean): void }).addEventListener(type, listener, capture);
  };
  const ownTarget = (target: ElementLike | null, attribute: string): GalleryElement | undefined => {
    let found: GalleryElement | undefined;
    for (let node = target as GalleryElement | null; node != null; node = node.parentElement ?? null) {
      if (node === root) return found;
      if (node.hasAttribute('data-can-gallery')) return undefined;
      if (found === undefined && node.hasAttribute(attribute)) found = node;
    }
    return undefined;
  };
  const showPreview = async (
    button: ElementLike, token: number,
    rawPreviewUrl: string | null, rawOriginalUrl: string | null, alt: string,
    current: () => boolean,
  ) => {
    state.textContent = loading;
    if (!dialog.open) dialog.showModal();
    root.querySelector?.('[data-can-gallery-close]')?.focus();
    const previewUrl = protectedUrl(rawPreviewUrl, internals);
    const originalUrl = protectedUrl(rawOriginalUrl, internals);
    if (internals.imageFetch === undefined) throw new Error('Gallery preview transport is unavailable.');
    controller = new AbortController();
    const response = await internals.imageFetch(previewUrl, { method: 'GET', cache: 'no-store', credentials: 'same-origin',
      mode: 'same-origin', redirect: 'error', signal: controller.signal });
    if (!current()) { if (token === version) invalidate(); return; }
    checkPreviewResponse(response);
    const blob = await response.blob();
    if (!current()) { if (token === version) invalidate(); return; }
    objectUrl = URL.createObjectURL(blob); image.setAttribute('src', objectUrl);
    await image.decode();
    if (!current()) { if (token === version) invalidate(); return; }
    image.setAttribute('alt', alt); image.removeAttribute('hidden'); state.textContent = '';
    original.setAttribute('href', originalUrl); original.removeAttribute('hidden');
  };
  const activate = async (button: ElementLike) => {
    if (!connected() || !button.isConnected) return;
    invalidate(); opener = button;
    const token = version;
    const rawPreviewUrl = button.getAttribute('data-can-preview-url');
    const rawOriginalUrl = button.getAttribute('data-can-original-url');
    const alt = button.querySelector?.('[data-can-gallery-thumb]')?.getAttribute('alt') ?? '';
    const current = () => connected() && button.isConnected && token === version &&
      ownTarget(button, 'data-can-gallery-preview') === button &&
      button.getAttribute('data-can-preview-url') === rawPreviewUrl &&
      button.getAttribute('data-can-original-url') === rawOriginalUrl &&
      root.querySelector?.('[data-can-gallery-dialog]') === dialog &&
      root.querySelector?.('[data-can-gallery-image]') === image &&
      root.querySelector?.('[data-can-gallery-state]') === state &&
      root.querySelector?.('[data-can-gallery-preview-original]') === original;
    try {
      await showPreview(button, token, rawPreviewUrl, rawOriginalUrl, alt, current);
    } catch {
      if (!current()) { if (token === version) invalidate(); return; }
      invalidate(); state.textContent = error;
    }
  };
  const thumbnails = new WeakMap<ElementLike, number>();
  const thumbnailState = (thumb: GalleryImage) => {
    const button = ownTarget(thumb, 'data-can-gallery-preview');
    return button?.querySelector?.('[data-can-gallery-thumb-state]') as StatusElement | null | undefined;
  };
  const failed = (thumb: GalleryImage) => {
    thumbnails.set(thumb, (thumbnails.get(thumb) ?? 0) + 1);
    if (connected() && thumb.isConnected) { const outlet = thumbnailState(thumb); if (outlet != null) outlet.textContent = error; }
  };
  const loaded = async (thumb: GalleryImage) => {
    const outlet = thumbnailState(thumb);
    if (outlet == null || typeof thumb.decode !== 'function') return;
    const token = (thumbnails.get(thumb) ?? 0) + 1, src = thumb.getAttribute('src');
    thumbnails.set(thumb, token); outlet.textContent = loading;
    const current = () => connected() && thumb.isConnected && thumbnails.get(thumb) === token &&
      thumb.getAttribute('src') === src && thumbnailState(thumb) === outlet;
    try { await thumb.decode(); if (current()) outlet.textContent = ''; }
    catch { if (current()) outlet.textContent = error; }
  };
  const wireGalleryEvents = () => {
    listen(root, 'click', event => {
      const closeButton = ownTarget(event.target, 'data-can-gallery-close');
      if (closeButton !== undefined) { event.preventDefault(); close(); return; }
      const button = ownTarget(event.target, 'data-can-gallery-preview');
      if (button !== undefined) { event.preventDefault(); void activate(button); return; }
      const link = ownTarget(event.target, 'data-can-gallery-original') ?? ownTarget(event.target, 'data-can-gallery-preview-original');
      if (link !== undefined) { try { protectedUrl(link.getAttribute('href'), internals); } catch { event.preventDefault(); } }
    });
    listen(root, 'load', event => { const thumb = ownTarget(event.target, 'data-can-gallery-thumb'); if (thumb !== undefined) void loaded(thumb as GalleryImage); }, true);
    listen(root, 'error', event => { const thumb = ownTarget(event.target, 'data-can-gallery-thumb'); if (thumb !== undefined) failed(thumb as GalleryImage); }, true);
    primeGalleryThumbs();
    listen(dialog, 'cancel', event => { event.preventDefault(); close(); });
    listen(dialog, 'close', () => { if (!dialog.open && (opener !== undefined || controller !== undefined || objectUrl !== undefined)) close(); });
  };
  const primeGalleryThumbs = () => {
    for (const thumb of root.querySelectorAll?.('[data-can-gallery-thumb]') ?? []) {
      const outlet = thumbnailState(thumb as GalleryImage);
      if (outlet == null) continue;
      outlet.textContent = loading;
      if ((thumb as GalleryImage).complete === true) {
        if (((thumb as GalleryImage).naturalWidth ?? 0) > 0) void loaded(thumb as GalleryImage);
        else if (thumb.getAttribute('src') !== null) failed(thumb as GalleryImage);
      }
    }
  };
  try {
    wireGalleryEvents();
  } catch (failure) {
    try { dispose(); } catch { /* Preserve the acquisition failure. */ }
    throw failure;
  }
  return dispose;
};
