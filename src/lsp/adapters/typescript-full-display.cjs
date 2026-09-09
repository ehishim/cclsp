/** Preserve full quick-info types using the provider's existing Program and TypeChecker. */
module.exports = function initialize({ typescript: ts }) {
  return {
    create(info) {
      const service = info.languageService;
      return new Proxy(service, {
        get(target, property) {
          if (property !== 'getQuickInfoAtPosition') {
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (fileName, position) => {
            const original = service.getQuickInfoAtPosition(fileName, position);
            if (!original) return original;
            const currentDisplay = ts.displayPartsToString(original.displayParts);
            if (!/\.\.\.\s*\d+\s+more|\{\s*\.\.\.\s*\}|\[\.\.\.\]|\.\.\.$/.test(currentDisplay))
              return original;
            const program = service.getProgram();
            const file = program?.getSourceFile(fileName);
            if (!file) return original;
            let node = file;
            for (;;) {
              const child = node
                .getChildren(file)
                .find((entry) => entry.getStart(file) <= position && position < entry.end);
              if (!child) break;
              node = child;
            }
            const checker = program.getTypeChecker();
            const symbol = checker.getSymbolAtLocation(node);
            if (!symbol) return original;
            const type = checker.getTypeOfSymbolAtLocation(symbol, node);
            const flags =
              ts.TypeFormatFlags.NoTruncation |
              ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
            const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
            const name = symbol.getName();
            const display = signatures.length
              ? signatures
                  .map((signature) => `${name}${checker.signatureToString(signature, node, flags)}`)
                  .join('\n')
              : `${name}: ${checker.typeToString(type, node, flags)}`;
            return { ...original, displayParts: [{ text: display, kind: 'text' }] };
          };
        },
      });
    },
  };
};
