// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { ToggleButton } from "react-aria-components";

// The OS picks light or dark (styles.css) until the user chooses; the choice is kept locally.
const KEY = "opa-theme";
const html = document.documentElement.style;
// Storage can be blocked (it throws then); the theme then follows the OS and isn't remembered.
const storage = (fn: () => void) => {
  try {
    fn();
  } catch {}
};
storage(() => {
  html.colorScheme = localStorage.getItem(KEY) ?? "";
});

export function ThemeToggle({ className }: { className: string }) {
  const [dark, setDark] = useState(() =>
    html.colorScheme
      ? html.colorScheme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches,
  );
  return (
    <ToggleButton
      isSelected={dark}
      onChange={(next) => {
        html.colorScheme = next ? "dark" : "light";
        storage(() => localStorage.setItem(KEY, html.colorScheme));
        setDark(next);
      }}
      className={className}
    >
      Dark theme
    </ToggleButton>
  );
}
