import ts from 'typescript';
/** Parse invocation sites and exact string tokens. Notifications such as turn/started are data. */
export function modelCallStructure(source: string) {
  const tree=ts.createSourceFile('source.ts',source,ts.ScriptTarget.Latest,true);
  let turnStarts=0, turnLiterals=0, modelQueries=0, metadataQueries=0;
  function walk(node: ts.Node) {
    if (ts.isStringLiteralLike(node) && node.text==='turn/start') turnLiterals++;
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text==='request' && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text==='turn/start') turnStarts++;
      if (ts.isIdentifier(node.expression) && node.expression.text==='query') {
        const arg=node.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) throw new Error('QUERY_ARGUMENT_NOT_LITERAL');
        const prop=arg.properties.find(p=>p.name?.getText(tree)==='prompt');
        if (prop && ts.isPropertyAssignment(prop) && ts.isCallExpression(prop.initializer) && prop.initializer.expression.getText(tree)==='noModelMessages') metadataQueries++;
        else if (prop && ((ts.isShorthandPropertyAssignment(prop) && prop.name.text==='prompt') || (ts.isPropertyAssignment(prop) && prop.initializer.getText(tree)==='input.prompt'))) modelQueries++;
        else throw new Error('UNCLASSIFIED_MODEL_QUERY');
      }
    }
    ts.forEachChild(node,walk);
  }
  walk(tree);return {turnStarts,turnLiterals,modelQueries,metadataQueries};
}
