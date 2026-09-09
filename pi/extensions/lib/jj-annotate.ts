// Machine-readable template for `jj file annotate`; content comes last because it can contain tabs.
export const JJ_ANNOTATE_TEMPLATE = String.raw`commit.change_id().shortest(8) ++ "\t" ++ commit.author().name() ++ "\t" ++ commit_timestamp(commit).local().format("%Y-%m-%d") ++ "\t" ++ commit.description().first_line() ++ "\t" ++ line_number ++ "\t" ++ content`;

// Author and date move out of the per-line prefix into a legend, which halves the output and
// lets the legend carry the description, which the default annotate output never had room for.
export function formatJjAnnotate(
  output: string,
  offset: number | undefined,
  limit: number | undefined,
): string {
  const rows = parseAnnotateOutput(output);
  if (rows.length === 0) return "";

  const start = Math.max((offset ?? 1) - 1, 0);
  if (start >= rows.length) {
    return `(no lines: offset ${start + 1} starts past the end of this ${rows.length}-line file)`;
  }
  const page = rows.slice(
    start,
    limit === undefined ? undefined : start + Math.max(limit, 0),
  );

  const firstRowByChange = new Map<string, AnnotatedLine>();
  for (const row of page) {
    if (!firstRowByChange.has(row.changeId)) firstRowByChange.set(row.changeId, row);
  }

  const lines = [...firstRowByChange.values()].map(
    ({ changeId, author, date, description }) =>
      `${changeId}  ${author} ${date}  ${description || "(no description set)"}`,
  );
  lines.push("");
  if (offset !== undefined || limit !== undefined) {
    lines.push(`[lines ${start + 1}-${start + page.length} of ${rows.length}]`);
  }
  for (const { changeId, lineNumber, content } of page) {
    lines.push(`${changeId} ${String(lineNumber).padStart(4)}: ${content}`);
  }
  return lines.join("\n");
}

interface AnnotatedLine {
  changeId: string;
  author: string;
  date: string;
  description: string;
  lineNumber: number;
  content: string;
}

function parseAnnotateOutput(output: string): AnnotatedLine[] {
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => {
    const [changeId, author, date, description, lineNumber, ...content] = line.split("\t");
    return {
      changeId,
      author,
      date,
      description,
      lineNumber: Number(lineNumber),
      content: content.join("\t"),
    };
  });
}
