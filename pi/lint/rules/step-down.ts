import { AST_NODE_TYPES, ESLintUtils } from "@typescript-eslint/utils";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

/**
 * Enforces the step-down rule: a top-level function, class, interface or type alias sits below
 * every top-level statement that uses it, so a file reads from its entry points down to the
 * details. Two declarations that use each other are exempt, since no order satisfies both.
 *
 * The fix moves every misplaced helper below its last user in one edit. It leaves classes, which
 * are not hoisted, and overloaded or merged declarations where they are, and reports them without
 * a fix.
 */
export const stepDown = ESLintUtils.RuleCreator.withoutDocs<[], "helperAboveUser">({
  meta: {
    type: "suggestion",
    fixable: "code",
    messages: {
      helperAboveUser: "'{{name}}' is used by {{user}} below it. Move it below its users (step-down rule).",
    },
    schema: [],
    defaultOptions: [],
  },
  create(context) {
    return {
      "Program:exit"(program: TSESTree.Program): void {
        reportHelpersAboveUsers(context, program);
      },
    };
  },
});

function reportHelpersAboveUsers(context: Context, program: TSESTree.Program): void {
  const helpers = collectHelpers(program);
  const usersByName = new Map<string, ReadonlySet<TSESTree.ProgramStatement>>();
  for (const [name, helper] of helpers) {
    usersByName.set(name, collectUsers(context, program, helper));
  }
  const misplaced = misplacedHelpers(helpers, usersByName);
  const order = misplaced.length === 0 ? undefined : reorderedBody(program, helpers, usersByName);
  // One edit reorders the whole file, so only the first report carries it.
  for (const [index, { name, helper, user }] of misplaced.entries()) {
    const userName = statementName(user);
    context.report({
      node: helper.id,
      messageId: "helperAboveUser",
      data: { name, user: userName === undefined ? "a top-level statement" : `'${userName}'` },
      // eslint-disable-next-line unicorn/no-null -- ESLint's `fix` takes null for a report without a fix
      fix: index === 0 && order !== undefined ? (fixer) => reorderFix(fixer, context.sourceCode, program, order) : null,
    });
  }
}

function misplacedHelpers(helpers: ReadonlyMap<string, Helper>, usersByName: UsersByName): readonly MisplacedHelper[] {
  const misplaced: MisplacedHelper[] = [];
  for (const [name, helper] of helpers) {
    const user = firstUserBelow(helper, usersByName);
    if (user !== undefined) misplaced.push({ name, helper, user });
  }
  return misplaced;
}

/** The body order with every movable helper below its last user, or undefined when nothing moves or the order does not settle. */
function reorderedBody(
  program: TSESTree.Program,
  helpers: ReadonlyMap<string, Helper>,
  usersByName: UsersByName,
): readonly TSESTree.ProgramStatement[] | undefined {
  // Walking the helpers from the bottom keeps two helpers of the same user in their original order.
  const movable = [...helpers.values()].filter((helper) => isMovable(helper, program)).reverse();
  let order: readonly TSESTree.ProgramStatement[] = program.body;
  // A helper that moves can pull its own helpers along, so the walk repeats until nothing moves.
  // A usage cycle longer than two never settles; the pass limit gives up on it.
  for (let pass = 0; pass <= program.body.length; pass++) {
    let changed = false;
    for (const helper of movable) {
      const moved = movedBelowLastUser(order, helper, usersByName);
      if (moved === undefined) continue;
      order = moved;
      changed = true;
    }
    if (!changed) return order === program.body ? undefined : order;
  }
  return undefined;
}

function movedBelowLastUser(
  order: readonly TSESTree.ProgramStatement[],
  helper: Helper,
  usersByName: UsersByName,
): readonly TSESTree.ProgramStatement[] | undefined {
  const lastUser = lastUserIndex(order, helper, usersByName);
  if (lastUser <= order.indexOf(helper.statement)) return undefined;
  const moved = order.filter((statement) => statement !== helper.statement);
  // Without the helper, its last user sits one place earlier, so this inserts directly after it.
  moved.splice(lastUser, 0, helper.statement);
  return moved;
}

function lastUserIndex(order: readonly TSESTree.ProgramStatement[], helper: Helper, usersByName: UsersByName): number {
  let last = -1;
  for (const user of usersByName.get(helper.id.name) ?? []) {
    if (usesEachOther(helper, user, usersByName)) continue;
    last = Math.max(last, order.indexOf(user));
  }
  return last;
}

/** Functions without overloads, interfaces and type aliases: moving them cannot change what runs. */
function isMovable(helper: Helper, program: TSESTree.Program): boolean {
  if (helper.declaration.type === AST_NODE_TYPES.ClassDeclaration) return false;
  return program.body.filter((statement) => statementName(statement) === helper.id.name).length === 1;
}

function reorderFix(
  fixer: TSESLint.RuleFixer,
  sourceCode: Readonly<TSESLint.SourceCode>,
  program: TSESTree.Program,
  order: readonly TSESTree.ProgramStatement[],
): TSESLint.RuleFix {
  const { chunks, range } = layoutOf(sourceCode, program);
  const text = order.map((statement, position) => chunkText(chunks.get(statement), position)).join("");
  return fixer.replaceTextRange(range, text);
}

function chunkText(chunk: Chunk | undefined, position: number): string {
  if (chunk === undefined) return "";
  // The first chunk starts the region directly; any other needs a blank line unless its gap already starts one.
  if (position === 0) return `${chunk.gap.trimStart()}${chunk.content}`;
  return `${/^\s/.test(chunk.gap) ? chunk.gap : `\n\n${chunk.gap}`}${chunk.content}`;
}

/** Cuts the top-level statements into chunks and returns the range they cover. */
function layoutOf(sourceCode: Readonly<TSESLint.SourceCode>, program: TSESTree.Program): Layout {
  const text = sourceCode.getText();
  const chunks = new Map<TSESTree.ProgramStatement, Chunk>();
  let regionStart = 0;
  let previousEnd = 0;
  for (const [index, statement] of program.body.entries()) {
    // The file header stays on top, so the first chunk only takes the comments attached to its statement.
    const gapStart = index === 0 ? attachedCommentsStart(sourceCode, statement) : previousEnd;
    if (index === 0) regionStart = gapStart;
    const end = endWithTrailingComments(sourceCode, statement);
    chunks.set(statement, { gap: text.slice(gapStart, statement.range[0]), content: text.slice(statement.range[0], end) });
    previousEnd = end;
  }
  return { chunks, range: [regionStart, previousEnd] };
}

/** Where the comments directly above `statement`, with no blank line in between, begin. */
function attachedCommentsStart(sourceCode: Readonly<TSESLint.SourceCode>, statement: TSESTree.ProgramStatement): number {
  let start = statement.range[0];
  let line = statement.loc.start.line;
  for (const comment of sourceCode.getCommentsBefore(statement).toReversed()) {
    if (isShebang(comment) || comment.loc.end.line < line - 1) break;
    start = comment.range[0];
    line = comment.loc.start.line;
  }
  return start;
}

/** typescript-estree reports `#!/usr/bin/env node` as a line comment at the start of the file. */
function isShebang(comment: TSESTree.Comment): boolean {
  return comment.range[0] === 0 && comment.value.startsWith("!");
}

/** The end of `statement`, including comments that start on its last line. */
function endWithTrailingComments(sourceCode: Readonly<TSESLint.SourceCode>, statement: TSESTree.ProgramStatement): number {
  let end = statement.range[1];
  for (const comment of sourceCode.getCommentsAfter(statement)) {
    if (comment.loc.start.line !== statement.loc.end.line) break;
    end = comment.range[1];
  }
  return end;
}

function collectHelpers(program: TSESTree.Program): ReadonlyMap<string, Helper> {
  const helpers = new Map<string, Helper>();
  for (const statement of program.body) {
    const declaration = declarationOf(statement);
    if (declaration === undefined || !isHelperDeclaration(declaration) || declaration.id === null) continue;
    // Overload signatures share the implementation's name; the implementation comes last and wins.
    helpers.set(declaration.id.name, { declaration, id: declaration.id, statement });
  }
  return helpers;
}

function collectUsers(context: Context, program: TSESTree.Program, helper: Helper): ReadonlySet<TSESTree.ProgramStatement> {
  const users = new Set<TSESTree.ProgramStatement>();
  for (const variable of context.sourceCode.getDeclaredVariables(helper.declaration)) {
    for (const reference of variable.references) {
      const user = enclosingStatement(program, reference.identifier);
      if (user === undefined || user === helper.statement || isReExport(user)) continue;
      users.add(user);
    }
  }
  return users;
}

function enclosingStatement(program: TSESTree.Program, node: TSESTree.Node): TSESTree.ProgramStatement | undefined {
  return program.body.find((statement) => statement.range[0] <= node.range[0] && node.range[1] <= statement.range[1]);
}

/** `export { helper }` and `export default helper` only name the helper, they do not use it. */
function isReExport(statement: TSESTree.ProgramStatement): boolean {
  if (statement.type === AST_NODE_TYPES.ExportNamedDeclaration) return statement.declaration === null;
  if (statement.type === AST_NODE_TYPES.ExportDefaultDeclaration) return statement.declaration.type === AST_NODE_TYPES.Identifier;
  return statement.type === AST_NODE_TYPES.TSExportAssignment;
}

function firstUserBelow(helper: Helper, usersByName: UsersByName): TSESTree.ProgramStatement | undefined {
  for (const user of usersByName.get(helper.id.name) ?? []) {
    if (user.range[0] < helper.statement.range[0]) continue;
    if (usesEachOther(helper, user, usersByName)) continue;
    return user;
  }
  return undefined;
}

function usesEachOther(helper: Helper, user: TSESTree.ProgramStatement, usersByName: UsersByName): boolean {
  const userName = statementName(user);
  return userName !== undefined && (usersByName.get(userName)?.has(helper.statement) ?? false);
}

function statementName(statement: TSESTree.ProgramStatement): string | undefined {
  const declaration = declarationOf(statement);
  if (declaration === undefined || !isHelperDeclaration(declaration)) return undefined;
  return declaration.id?.name;
}

function declarationOf(statement: TSESTree.ProgramStatement): TSESTree.Node | undefined {
  if (statement.type === AST_NODE_TYPES.ExportNamedDeclaration || statement.type === AST_NODE_TYPES.ExportDefaultDeclaration) {
    return statement.declaration ?? undefined;
  }
  return statement;
}

function isHelperDeclaration(node: TSESTree.Node): node is HelperDeclaration {
  return (
    node.type === AST_NODE_TYPES.ClassDeclaration ||
    node.type === AST_NODE_TYPES.FunctionDeclaration ||
    node.type === AST_NODE_TYPES.TSDeclareFunction ||
    node.type === AST_NODE_TYPES.TSInterfaceDeclaration ||
    node.type === AST_NODE_TYPES.TSTypeAliasDeclaration
  );
}

type Context = Readonly<TSESLint.RuleContext<"helperAboveUser", []>>;

type UsersByName = ReadonlyMap<string, ReadonlySet<TSESTree.ProgramStatement>>;

interface MisplacedHelper {
  readonly name: string;
  readonly helper: Helper;
  readonly user: TSESTree.ProgramStatement;
}

interface Layout {
  readonly chunks: ReadonlyMap<TSESTree.ProgramStatement, Chunk>;
  readonly range: TSESTree.Range;
}

/** A statement and the text before it, which holds its whitespace and leading comments. */
interface Chunk {
  readonly gap: string;
  readonly content: string;
}

interface Helper {
  readonly declaration: HelperDeclaration;
  readonly id: TSESTree.Identifier;
  readonly statement: TSESTree.ProgramStatement;
}

type HelperDeclaration =
  | TSESTree.ClassDeclaration
  | TSESTree.FunctionDeclaration
  | TSESTree.TSDeclareFunction
  | TSESTree.TSInterfaceDeclaration
  | TSESTree.TSTypeAliasDeclaration;
