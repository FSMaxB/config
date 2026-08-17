import type {
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

// Rename the hardcoded built-in title before components wrap it to the viewport width.
export function renameRenderedTitle(
  definition: ToolDefinition<any, any, any>,
  newName: string,
): ToolDefinition<any, any, any>["renderCall"] {
  const { name: originalName, renderCall } = definition;
  if (renderCall === undefined) return undefined;

  const titlePattern = new RegExp(
    `^((?:\\x1b\\[[0-9;]*m)*)${originalName}\\b`,
  );
  return (args, theme, context) =>
    renderCall(
      args,
      withRenamedToolTitle(theme, titlePattern, newName),
      context,
    );
}

function withRenamedToolTitle(
  theme: Theme,
  titlePattern: RegExp,
  newName: string,
): Theme {
  const renamed: Theme = Object.create(theme);
  renamed.fg = (color, text) =>
    theme.fg(
      color,
      color === "toolTitle" ? text.replace(titlePattern, `$1${newName}`) : text,
    );
  return renamed;
}
