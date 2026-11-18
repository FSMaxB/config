import { AST_NODE_TYPES, ESLintUtils } from "@typescript-eslint/utils";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

/**
 * Enforces the step-down rule: a top-level function, class, interface or type alias sits below
 * every top-level statement that uses it, so a file reads from its entry points down to the
 * details. Two declarations that use each other are exempt, since no order satisfies both.
 */
export const stepDown = ESLintUtils.RuleCreator.withoutDocs<[], "helperAboveUser">({
  meta: {
    type: "suggestion",
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
  for (const [name, helper] of helpers) {
    const user = firstUserBelow(helper, usersByName);
    if (user === undefined) continue;
    const userName = statementName(user);
    context.report({
      node: helper.id,
      messageId: "helperAboveUser",
      data: { name, user: userName === undefined ? "a top-level statement" : `'${userName}'` },
    });
  }
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

function firstUserBelow(
  helper: Helper,
  usersByName: ReadonlyMap<string, ReadonlySet<TSESTree.ProgramStatement>>,
): TSESTree.ProgramStatement | undefined {
  for (const user of usersByName.get(helper.id.name) ?? []) {
    if (user.range[0] < helper.statement.range[0]) continue;
    const userName = statementName(user);
    const usesEachOther = userName !== undefined && (usersByName.get(userName)?.has(helper.statement) ?? false);
    if (usesEachOther) continue;
    return user;
  }
  return undefined;
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
