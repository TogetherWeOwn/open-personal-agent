// SPDX-License-Identifier: Apache-2.0
// Vite's `?raw` imports: the file's text.
declare module "*?raw" {
  const text: string;
  export default text;
}

// Vite's `import.meta.glob`, as the tests use it: eager `?raw` imports of each file's text.
interface ImportMeta {
  glob(
    patterns: string[],
    options: { query: "?raw"; import: "default"; eager: true },
  ): Record<string, string>;
}
