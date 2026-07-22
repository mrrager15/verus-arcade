// Minimal ambient typing for `qrcode` — only the surface the web component
// uses. Avoids pulling in `@types/qrcode` so the package has zero extra type
// dependencies for the browser entry.
declare module 'qrcode' {
  interface ToDataURLOptions {
    margin?: number;
    width?: number;
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  }
  function toDataURL(text: string, options?: ToDataURLOptions): Promise<string>;
  const _default: { toDataURL: typeof toDataURL };
  export default _default;
}
