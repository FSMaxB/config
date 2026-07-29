import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const title = () => {
    const sessionName = pi.getSessionName();
    return sessionName ? `Pi — ${sessionName}` : "Pi";
  };

  pi.on("tool_execution_start", async (event) => {
    switch (event.toolName) {
      case "question":
        notify(title(), "Waiting for your answer");
        break;
      case "submit_plan":
        notify(title(), "Plan submitted for review");
        break;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle()) return;
    notify(title(), "Ready for input");
  });
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
