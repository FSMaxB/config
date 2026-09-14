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
  // The status belongs in the body rather than the title: a long session name
  // would otherwise crowd it out, and terminal-notifier rejects an empty body.
  const title = ["Pi", sessionName].filter(Boolean).join(" — ");
  // Details quote outside text (ui prompt titles, error messages), which may
  // hold arbitrary characters; the display filter keeps them notification-safe.
  notify(
    title,
    detail === undefined
      ? status
      : `${status}: ${sanitizeDisplayText(detail, DETAIL_MAX_LENGTH)}`,
  );
}

function notify(title: string, body: string): void {
  switch (process.platform) {
    case "darwin":
      notifyMacOs(title, body);
      break;
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

// Notifications posted through osascript are inert: clicking one does nothing,
// so the session it announces stays as hard to find as before. terminal-notifier
// can run a command on click, which is what gets us back to the pane pi runs in.
// It is optional, and needs a one-time `lsregister -f <its .app>` per install to
// be allowed to post at all, hence the fallback on any failure.
function notifyMacOs(title: string, body: string): void {
  const clickCommand = focusPaneCommand();
  if (clickCommand === undefined) {
    notifyAppleScript(title, body);
    return;
  }
  execFile(
    "terminal-notifier",
    ["-title", title, "-message", body, "-sound", "Glass", "-execute", clickCommand],
    (error) => {
      // A missing binary or a denied notification permission leaves nothing on
      // screen, so a silent failure here would cost us the notification itself.
      if (error) notifyAppleScript(title, body);
    },
  );
}

function focusPaneCommand(): string | undefined {
  const {
    // macOS sets this for processes launched from an app bundle, so it names
    // the terminal emulator pi is running in.
    __CFBundleIdentifier: terminalBundleId,
    ZELLIJ_SESSION_NAME: zellijSession,
    ZELLIJ_PANE_ID: zellijPane,
    PATH: path,
  } = process.env;
  const steps = [];
  if (terminalBundleId) steps.push(`open -b ${shellQuote(terminalBundleId)}`);
  // Raising the terminal window is not enough inside a multiplexer: focusing
  // the pane also switches to the tab holding it.
  if (zellijSession && zellijPane) {
    steps.push(
      `zellij -s ${shellQuote(zellijSession)} action focus-pane-id ${shellQuote(`terminal_${zellijPane}`)}`,
    );
  }
  if (steps.length === 0) return undefined;
  // The click command runs from a relaunched terminal-notifier, which inherits
  // launchd's bare PATH instead of one holding zellij.
  return [`export PATH=${shellQuote(path ?? "")}`, ...steps].join("; ");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function notifyAppleScript(title: string, body: string): void {
  const script = `display notification "${escapeAppleScriptString(body)}" with title "${escapeAppleScriptString(title)}" sound name "Glass"`;
  execFile("osascript", ["-e", script], () => {});
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
