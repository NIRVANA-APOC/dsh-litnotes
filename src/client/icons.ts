/**
 * Inline SVG artwork for the plugin (sidebar icon and empty-state art).
 *
 * The markup is injected into a span with `dangerouslySetInnerHTML`; it is
 * authored by this project (no third-party icon set), so no sanitization step
 * is needed. Colors inherit `currentColor`; the host rewrites the outer `<svg>`
 * tag dimensions where needed.
 */

/** Sidebar panel icon: a sheet with a ruled margin and annotation dots. */
export const PANEL_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="none" aria-hidden="true"><g stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4.25" y="2.75" width="15.5" height="18.5" rx="2.25"/><path d="M14.5 5.5v12.9" opacity=".45"/><path d="M7.25 7.5h4.9M7.25 11h4.9M7.25 14.5h3.2"/></g><circle cx="16.9" cy="8.1" r="1.15" fill="currentColor" stroke="none"/><circle cx="16.9" cy="14.2" r="1.15" fill="currentColor" stroke="none" opacity=".55"/></svg>`
