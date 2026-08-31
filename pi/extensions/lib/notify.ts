import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeDisplayText } from "./format.ts";

export function notifyUser(
  pi: ExtensionAPI,
  status: string,
  detail?: string,
): void {
  // Subagent children load the global extensions too; their lifecycle events
  // must not raise desktop notifications meant for the interactive session.
  if (process.env.PI_SUBAGENT_CHILD) return;
  const DETAIL_MAX_LENGTH = 120;
  const sessionName = pi.getSessionName();
  const title = ["Pi", sessionName, status].filter(Boolean).join(" — ");
  // Details quote outside text (ui prompt titles, error messages), which may
  // hold arbitrary characters; the display filter keeps them notification-safe.
  notify(
    title,
    detail === undefined ? "" : sanitizeDisplayText(detail, DETAIL_MAX_LENGTH),
  );
}

function notify(title: string, body: string): void {
  switch (process.platform) {
    case "darwin": {
      const script = `display notification "${escapeAppleScriptString(body)}" with title "${escapeAppleScriptString(title)}" sound name "Glass"`;
      execFile("osascript", ["-e", script], () => {});
      break;
    }
    case "linux":
      execFile("notify-send", ["--app-name=Pi", title, body], () => {});
      break;
    case "win32":
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", windowsToastScript(title, body)],
        () => {},
      );
      break;
  }
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Windows has no notification CLI, so go through the WinRT toast API via PowerShell.
function windowsToastScript(title: string, body: string): string {
  return `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $template.GetElementsByTagName('text')
$texts.Item(0).AppendChild($template.CreateTextNode('${escapePowerShellString(title)}')) | Out-Null
$texts.Item(1).AppendChild($template.CreateTextNode('${escapePowerShellString(body)}')) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Pi').Show($toast)
`;
}

function escapePowerShellString(value: string): string {
  return value.replace(/'/g, "''");
}
