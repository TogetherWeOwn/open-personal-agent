// SPDX-License-Identifier: Apache-2.0
import { type ComponentProps, type ReactNode, useState } from "react";
import { Button } from "react-aria-components";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Assistant output as Markdown that can't reach another host or run script (F-3.4, R7 M3-7,
 * m3-ux §5.4). Raw HTML is dropped, so `<img>`, `<svg>`, `<script>` and event handlers never
 * reach the DOM. Only same-origin `/api/files/` images load; other images become plain links.
 * Links are `http(s)` and `mailto` only and open in a new tab without a referrer.
 */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm, plainFootnotes, nestHeadings]}
      urlTransform={(url, key) => (key === "src" && isOwnFile(url) ? url : (safeHref(url) ?? ""))}
      components={{ ...COMPONENTS, pre: (p) => <CodeBlock {...p} copyable={!streaming} /> }}
    >
      {text}
    </ReactMarkdown>
  );
}

/** The URL if it's an `http(s)` or `mailto` link, else null. */
export function safeHref(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null; // relative or not a URL
  }
}

/** True only for a path on this app's file API that URL parsing leaves as written (no `..`). */
export function isOwnFile(src: string | undefined): src is string {
  if (!src?.startsWith("/api/files/") || /[?#\\%]/.test(src)) return false;
  return new URL(src, "https://app.invalid").pathname === src;
}

/** "example.com/cat.png" for an http(s) URL, else null. */
function shortUrl(href: string | null): string | null {
  if (!href?.startsWith("http")) return null;
  const url = new URL(href);
  return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return "";
}

/** The host the link text claims, if the text reads as a URL or bare domain. */
function claimedHost(text: string): string | null {
  try {
    return new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`).host;
  } catch {
    return null;
  }
}

function ExternalLink({
  href,
  children,
  hostInText = false,
}: {
  href: string;
  children: ReactNode;
  hostInText?: boolean;
}) {
  const host = href.startsWith("mailto:") ? null : new URL(href).host;
  const showHost = host && !hostInText && claimedHost(textOf(children).trim()) !== host;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline underline-offset-2"
    >
      {children}
      {showHost && <span className="text-text-muted"> ({host})</span>}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** Wide content scrolls sideways, reachable by keyboard (axe scrollable-region-focusable). */
function Scroller({
  label,
  className,
  children,
}: {
  label: string;
  className: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll it with the arrow keys
    <section aria-label={label} tabIndex={0} className={`overflow-x-auto ${className}`}>
      {children}
    </section>
  );
}

function CodeBlock({
  children,
  copyable,
}: ComponentProps<"pre"> & { copyable: boolean; node?: unknown }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="my-3">
      <Scroller label="Code" className="rounded-lg border border-border bg-surface-sunken">
        <pre className="p-3 font-mono text-sm">{children}</pre>
      </Scroller>
      {copyable && (
        <Button
          onPress={async () => {
            try {
              await navigator.clipboard.writeText(textOf(children).replace(/\n$/, ""));
              setCopy("copied");
              setTimeout(() => setCopy("idle"), 2000);
            } catch {
              setCopy("failed"); // denied, or no Clipboard API; stays until the next try
            }
          }}
          className="mt-1 min-h-11 rounded-lg px-2 text-sm text-text-muted data-hovered:text-text"
        >
          {
            {
              idle: "Copy code",
              copied: "Copied",
              failed: "Couldn't copy. Select the code instead.",
            }[copy]
          }
        </Button>
      )}
    </div>
  );
}

const heading =
  (Tag: "h2" | "h3" | "h4" | "h5" | "h6") =>
  ({ children }: { children?: ReactNode }) => (
    <Tag className="mt-4 mb-2 font-semibold first:mt-0">{children}</Tag>
  );

const COMPONENTS: Components = {
  a: ({ href, children }) => {
    const safe = safeHref(href);
    return safe ? <ExternalLink href={safe}>{children}</ExternalLink> : <span>{children}</span>;
  },
  img: ({ src, alt }) => {
    const source = typeof src === "string" ? src : undefined;
    if (isOwnFile(source)) return <img src={source} alt={alt ?? ""} className="max-w-full" />;
    const href = safeHref(source);
    const label = shortUrl(href) ?? (alt || "not shown");
    return href ? (
      <ExternalLink href={href} hostInText>
        Image: {label}
      </ExternalLink>
    ) : (
      <span>Image: {label}</span>
    );
  },
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-6">{children}</ul>,
  ol: ({ children, start }) => (
    <ol start={start} className="my-2 list-decimal pl-6">
      {children}
    </ol>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-4 border-border pl-3 text-text-muted">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) =>
    // Fenced code carries a `language-*` class; inline code doesn't.
    className ? (
      <code>{children}</code>
    ) : (
      <code className="rounded bg-surface-sunken px-1 font-mono text-[0.9em]">{children}</code>
    ),
  table: ({ children }) => (
    <Scroller label="Table" className="my-3">
      <table className="border-collapse text-sm">{children}</table>
    </Scroller>
  ),
  th: ({ children, style }) => (
    <th style={style} className="border border-border px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border border-border px-2 py-1">
      {children}
    </td>
  ),
  hr: () => <hr className="my-4 border-border" />,
  h2: heading("h2"),
  h3: heading("h3"),
  h4: heading("h4"),
  h5: heading("h5"),
  h6: heading("h6"),
};

type Heading = { type: "heading"; depth: number };
type Tree = {
  type: string;
  depth?: number;
  label?: string;
  value?: string;
  children?: Tree[] | undefined;
};

/**
 * GFM footnotes need in-page `#` links and ids, which this renderer doesn't allow (and ids would
 * repeat across replies). Keep the content as text instead: `x[^1]` reads "x[1]" and the note
 * becomes a paragraph starting "[1] " where it was written.
 */
function plainFootnotes() {
  const mark = (node: Tree) => `[${node.label}]`;
  const visit = (node: Tree): Tree[] => {
    if (node.type === "footnoteReference") return [{ type: "text", value: mark(node) }];
    const children = node.children?.flatMap(visit);
    if (node.type !== "footnoteDefinition") return [{ ...node, children }];
    const [first, ...rest] = children ?? [];
    const prefix: Tree = { type: "text", value: `${mark(node)} ` };
    return first?.type === "paragraph"
      ? [{ ...first, children: [prefix, ...(first.children ?? [])] }, ...rest]
      : [{ type: "paragraph", children: [prefix] }, ...(first ? [first] : []), ...rest];
  };
  return (tree: Tree) => {
    tree.children = tree.children?.flatMap(visit);
  };
}

/**
 * The page's h1 is the conversation title, so a reply's headings start at h2 and never skip a
 * level (axe heading-order), whatever depths the model wrote.
 */
function nestHeadings() {
  return (tree: Tree) => {
    let previous = 1;
    const visit = (node: Tree) => {
      if (node.type === "heading") {
        const h = node as Heading;
        h.depth = Math.min(Math.max(h.depth + 1, 2), previous + 1, 6);
        previous = h.depth;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
