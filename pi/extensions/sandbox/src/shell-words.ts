// A tokenizer, not a shell parser: it knows quoting, operators, redirections, comments, here-documents
// and command substitution, which is enough to find the words of each simple command.

/** The words of every simple command in `source`, unquoted, including those inside `$(...)` and backticks. */
export function simpleCommands(source: string): string[][] {
  const commands: string[][] = [];
  const substitutions: string[] = [];
  const hereDocuments: HereDocument[] = [];
  let words: string[] = [];
  let position = 0;
  while (position < source.length) {
    const character = source.charAt(position);
    if (character === " " || character === "\t") {
      position += 1;
    } else if (character === "#") {
      position = lineEnd(source, position);
    } else if (character === "\\" && source.charAt(position + 1) === "\n") {
      position += 2;
    } else if (character === "\n") {
      commands.push(words);
      words = [];
      position = hereDocumentsEnd(source, position + 1, hereDocuments.splice(0));
    } else {
      const operator = OPERATORS.find((candidate) => source.startsWith(candidate.text, position));
      if (operator === undefined) {
        const word = readWord(source, position);
        substitutions.push(...word.substitutions);
        position = word.end;
        if (!isFileDescriptor(word.text, source.charAt(word.end))) words.push(word.text);
      } else if (operator.kind === "separator") {
        commands.push(words);
        words = [];
        position += operator.text.length;
      } else {
        const target = readWord(source, skipBlanks(source, position + operator.text.length));
        substitutions.push(...target.substitutions);
        position = target.end;
        if (operator.kind === "hereDocument") hereDocuments.push({ delimiter: target.text, operator: operator.text });
      }
    }
  }
  commands.push(words);
  return [...commands.filter((command) => command.length > 0), ...substitutions.flatMap((substitution) => simpleCommands(substitution))];
}

// Longest first, so `&&` wins over `&` and `<<<` over `<<`.
const OPERATORS: readonly Operator[] = [
  { text: "&>>", kind: "redirect" },
  { text: "<<<", kind: "redirect" },
  { text: "<<-", kind: "hereDocument" },
  { text: "&&", kind: "separator" },
  { text: "||", kind: "separator" },
  { text: ";;", kind: "separator" },
  { text: ";&", kind: "separator" },
  { text: "|&", kind: "separator" },
  { text: "<<", kind: "hereDocument" },
  { text: "&>", kind: "redirect" },
  { text: ">>", kind: "redirect" },
  { text: ">&", kind: "redirect" },
  { text: "<&", kind: "redirect" },
  { text: "<>", kind: "redirect" },
  { text: ">|", kind: "redirect" },
  { text: ";", kind: "separator" },
  { text: "&", kind: "separator" },
  { text: "|", kind: "separator" },
  { text: "(", kind: "separator" },
  { text: ")", kind: "separator" },
  { text: "<", kind: "redirect" },
  { text: ">", kind: "redirect" },
];

// Here-document bodies start on the line after their operators, one after the other.
function hereDocumentsEnd(source: string, start: number, hereDocuments: readonly HereDocument[]): number {
  let position = start;
  for (const hereDocument of hereDocuments) position = hereDocumentEnd(source, position, hereDocument);
  return position;
}

function hereDocumentEnd(source: string, start: number, { delimiter, operator }: HereDocument): number {
  let position = start;
  while (position < source.length) {
    const end = lineEnd(source, position);
    const line = source.slice(position, end);
    position = end + 1;
    if ((operator === "<<-" ? line.replace(/^\t+/, "") : line) === delimiter) return Math.min(position, source.length);
  }
  return source.length;
}

interface HereDocument {
  delimiter: string;
  operator: HereDocumentOperator;
}

type Operator = { text: string; kind: "separator" | "redirect" } | { text: HereDocumentOperator; kind: "hereDocument" };
type HereDocumentOperator = "<<" | "<<-";

function lineEnd(source: string, start: number): number {
  const end = source.indexOf("\n", start);
  return end === -1 ? source.length : end;
}

// Blanks, newlines and operator characters end a word outside quotes. Exactly the characters the loop in
// simpleCommands consumes on its own: any other character ending a word would stop the loop from advancing.
const WORD_END = /[ \t\n;&|()<>]/;

function readWord(source: string, start: number): Word {
  let text = "";
  const substitutions: string[] = [];
  let position = start;
  while (position < source.length && !WORD_END.test(source.charAt(position))) {
    const character = source.charAt(position);
    const substitution = readSubstitution(source, position);
    if (substitution !== undefined) {
      substitutions.push(substitution.inner);
      text += source.slice(position, substitution.end);
      position = substitution.end;
    } else if (character === "\\") {
      text += source.charAt(position + 1) === "\n" ? "" : source.charAt(position + 1);
      position += 2;
    } else if (character === "'") {
      const end = closingQuote(source, position);
      text += source.slice(position + 1, end);
      position = end + 1;
    } else if (character === '"') {
      const quoted = readDoubleQuoted(source, position + 1);
      text += quoted.text;
      substitutions.push(...quoted.substitutions);
      position = quoted.end;
    } else {
      text += character;
      position += 1;
    }
  }
  return { text, end: Math.min(position, source.length), substitutions };
}

function readDoubleQuoted(source: string, start: number): Word {
  let text = "";
  const substitutions: string[] = [];
  let position = start;
  while (position < source.length && source.charAt(position) !== '"') {
    const substitution = readSubstitution(source, position);
    if (substitution !== undefined) {
      substitutions.push(substitution.inner);
      text += source.slice(position, substitution.end);
      position = substitution.end;
    } else if (source.charAt(position) === "\\") {
      text += escapedInDoubleQuotes(source.charAt(position + 1));
      position += 2;
    } else {
      text += source.charAt(position);
      position += 1;
    }
  }
  return { text, end: position + 1, substitutions };
}

interface Word {
  text: string;
  end: number;
  substitutions: string[];
}

// Inside double quotes a backslash only escapes $, `, ", \ and newline.
function escapedInDoubleQuotes(character: string): string {
  if (character === "\n") return "";
  return '$`"\\'.includes(character) ? character : `\\${character}`;
}

function readSubstitution(source: string, position: number): Substitution | undefined {
  if (source.startsWith("$(", position)) {
    const end = closingParenthesis(source, position + 2);
    return { inner: source.slice(position + 2, end), end: end + 1 };
  }
  if (source.charAt(position) !== "`") return undefined;
  const end = closingQuote(source, position);
  return { inner: source.slice(position + 1, end).replaceAll("\\`", "`"), end: end + 1 };
}

interface Substitution {
  inner: string;
  end: number;
}

function closingParenthesis(source: string, start: number): number {
  let depth = 1;
  let position = start;
  while (position < source.length) {
    const character = source.charAt(position);
    if (character === "\\") {
      position += 2;
    } else if (character === "'" || character === '"') {
      position = closingQuote(source, position) + 1;
    } else {
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (depth === 0) return position;
      position += 1;
    }
  }
  return source.length;
}

// The index of the quote (', " or `) that closes the one at `start`, or the end of an unterminated source.
function closingQuote(source: string, start: number): number {
  const quote = source.charAt(start);
  let position = start + 1;
  while (position < source.length && source.charAt(position) !== quote) {
    position += quote !== "'" && source.charAt(position) === "\\" ? 2 : 1;
  }
  return Math.min(position, source.length);
}

// The `2` in `2>&1`.
function isFileDescriptor(word: string, next: string): boolean {
  return /^\d+$/.test(word) && (next === "<" || next === ">");
}

function skipBlanks(source: string, start: number): number {
  let position = start;
  while (source.charAt(position) === " " || source.charAt(position) === "\t") position += 1;
  return position;
}
