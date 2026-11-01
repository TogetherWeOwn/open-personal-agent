// SPDX-License-Identifier: Apache-2.0
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

export const isDark = () =>
  html.colorScheme
    ? html.colorScheme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;

export function setDark(dark: boolean) {
  html.colorScheme = dark ? "dark" : "light";
  storage(() => localStorage.setItem(KEY, html.colorScheme));
}
