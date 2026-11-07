/**
 * Module declarations for the build-time asset plugins.
 *
 * CSS files are compiled to minified strings and SVG files to raw markup by
 * `scripts/build.ts`; TypeScript only needs to know their shape.
 */

declare module '*.css' {
  const css: string
  export default css
}

declare module '*.svg' {
  const markup: string
  export default markup
}
