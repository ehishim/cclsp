import type Parser from 'web-tree-sitter';
import { type DocumentSymbol, SymbolKind } from '../lsp/types.js';
import { SourceLocator } from './source-locator.js';
import type { AstLanguage } from './types.js';

const KIND_BY_NODE: Record<string, SymbolKind> = {
  class_declaration: SymbolKind.Class,
  class_definition: SymbolKind.Class,
  interface_declaration: SymbolKind.Interface,
  interface_type: SymbolKind.Interface,
  trait_declaration: SymbolKind.Interface,
  trait_item: SymbolKind.Interface,
  enum_declaration: SymbolKind.Enum,
  enum_item: SymbolKind.Enum,
  record_declaration: SymbolKind.Struct,
  struct_item: SymbolKind.Struct,
  function_declaration: SymbolKind.Function,
  function_definition: SymbolKind.Function,
  function_item: SymbolKind.Function,
  method_definition: SymbolKind.Method,
  method_declaration: SymbolKind.Method,
  constructor_declaration: SymbolKind.Constructor,
  type_alias_declaration: SymbolKind.TypeParameter,
  type_item: SymbolKind.TypeParameter,
  type_spec: SymbolKind.TypeParameter,
  mod_item: SymbolKind.Module,
  namespace_definition: SymbolKind.Namespace,
  variable_declarator: SymbolKind.Variable,
  const_spec: SymbolKind.Constant,
  var_spec: SymbolKind.Variable,
  const_item: SymbolKind.Constant,
  static_item: SymbolKind.Variable,
  property_declaration: SymbolKind.Property,
};

function findName(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  const field = node.childForFieldName('name') ?? node.childForFieldName('declarator');
  if (field) {
    if (
      field.type === 'name' ||
      field.type === 'identifier' ||
      field.type.endsWith('_identifier')
    ) {
      return field;
    }
    const identifier = field.descendantsOfType([
      'name',
      'identifier',
      'type_identifier',
      'property_identifier',
    ])[0];
    if (identifier) return identifier;
  }
  return node.descendantsOfType([
    'name',
    'identifier',
    'type_identifier',
    'property_identifier',
    'field_identifier',
  ])[0];
}

function hasAncestor(node: Parser.SyntaxNode, type: string): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.type === type) return true;
    parent = parent.parent;
  }
  return false;
}

function kindFor(node: Parser.SyntaxNode, parentKind?: SymbolKind): SymbolKind | undefined {
  const mapped = KIND_BY_NODE[node.type];
  if (!mapped) return undefined;
  if (node.type === 'type_spec') {
    const declaredType = node.childForFieldName('type');
    if (declaredType?.type === 'struct_type') return SymbolKind.Struct;
    if (declaredType?.type === 'interface_type') return SymbolKind.Interface;
  }
  if (node.type === 'variable_declarator' && node.parent?.type === 'field_declaration') {
    return SymbolKind.Field;
  }
  if (
    mapped === SymbolKind.Function &&
    (parentKind === SymbolKind.Class ||
      parentKind === SymbolKind.Interface ||
      hasAncestor(node, 'impl_item'))
  ) {
    return SymbolKind.Method;
  }
  return mapped;
}

export function extractDeclarations(
  tree: Parser.Tree,
  source: string,
  _language: AstLanguage
): DocumentSymbol[] {
  const locator = new SourceLocator(source);
  const visit = (node: Parser.SyntaxNode, parentKind?: SymbolKind): DocumentSymbol[] => {
    const kind = kindFor(node, parentKind);
    const nameNode = kind ? findName(node) : undefined;
    if (kind && nameNode) {
      const children = node.namedChildren.flatMap((child) => visit(child, kind));
      return [
        {
          name: nameNode.text,
          kind,
          range: locator.range(node),
          selectionRange: locator.range(nameNode),
          ...(children.length > 0 ? { children } : {}),
        },
      ];
    }
    return node.namedChildren.flatMap((child) => visit(child, parentKind));
  };
  return visit(tree.rootNode);
}
