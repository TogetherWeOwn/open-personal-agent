// SPDX-License-Identifier: Apache-2.0
// Settings › Deployment on iOS (m3-ux §3.13): Safari has no install prompt, so this says where
// Add to Home Screen is. Hidden once the app runs from the home screen.
import { Share } from "lucide-react";
import { isInstalled, isIos } from "../pwa";
import { Card, CardHeader } from "../ui";

export function InstallHint() {
  if (!isIos() || isInstalled()) return null;
  return (
    <Card labelledBy="install-hint">
      <CardHeader id="install-hint" level={2} title="Install as an app" />
      <p>Open your assistant from the home screen, like any other app.</p>
      <p className="flex flex-wrap items-center gap-1">
        In Safari, tap Share
        <Share aria-hidden="true" size={18} />, then Add to Home Screen.
      </p>
    </Card>
  );
}
