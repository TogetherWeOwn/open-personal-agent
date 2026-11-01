// SPDX-License-Identifier: Apache-2.0
// A suggested prompt picked in onboarding opens the chat with it in the composer, not sent (m3-ux
// §3.12). Onboarding leaves the app with a full navigation, so the prompt waits in this tab's
// session storage, never in the address, and the chat takes it once.
const KEY = "opa:prefill";

export function setPrefill(text: string) {
  try {
    sessionStorage.setItem(KEY, text);
  } catch {
    // Storage off: the chat simply opens empty.
  }
}

export function takePrefill(): string | null {
  try {
    const text = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return text;
  } catch {
    return null;
  }
}
