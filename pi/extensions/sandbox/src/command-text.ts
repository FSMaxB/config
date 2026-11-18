// Commands up to this length on each side of the cut are shown in full; a prompt has room for
// about two terminal lines of a command.
const EDGE_LENGTH = 120;
// An omission note is only worth it when it hides more than its own length.
const OMISSION_NOTE_LENGTH = 32;

// The tail matters as much as the head: an unexpected suffix on a long command is where a payload hides.
export function shortenedCommand(command: string, separator: string): string {
  if (command.length <= 2 * EDGE_LENGTH + OMISSION_NOTE_LENGTH) return command;
  const omitted = command.length - 2 * EDGE_LENGTH;
  return `${command.slice(0, EDGE_LENGTH)}${separator}…[${omitted} characters omitted]…${separator}${command.slice(-EDGE_LENGTH)}`;
}
