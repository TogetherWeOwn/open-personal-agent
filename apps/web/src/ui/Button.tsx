// SPDX-License-Identifier: Apache-2.0
// The one button (m3-ux §5.2). `buttonClass` styles a RAC `Link` or `ToggleButton` the same way.
// `className` only adds layout (margins, self-alignment); it never overrides a variant's classes.
import { Button as AriaButton, type ButtonProps, composeRenderProps } from "react-aria-components";

export type Variant = "primary" | "secondary" | "quiet" | "danger";

const base =
  "inline-flex min-h-11 items-center gap-2 rounded-lg font-medium data-disabled:opacity-50 data-pressed:opacity-90";
const variants: Record<Variant, string> = {
  primary: "justify-center bg-accent px-4 text-accent-contrast",
  secondary: "justify-center border border-border-strong px-4",
  quiet:
    "px-3 text-sm hover:bg-surface-raised data-pressed:bg-border data-selected:bg-surface-raised",
  danger: "justify-center bg-danger px-4 text-accent-contrast",
};

export const buttonClass = (variant: Variant = "secondary", className = "") =>
  `${base} ${variants[variant]} ${className}`.trim();

export function Button({
  variant = "secondary",
  className,
  ...props
}: ButtonProps & { variant?: Variant }) {
  return (
    <AriaButton
      {...props}
      className={composeRenderProps(className, (extra) => buttonClass(variant, extra))}
    />
  );
}
