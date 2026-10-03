'use strict';

// Local security patch for GHSA-vfj7-8cjw-p6xm, independently implemented
// against the integrity-verified official braces@3.0.3 source. Keep the
// package identity unchanged: this is not an official upstream release.
const MAX_NESTING = 128;

const assertNesting = depth => {
  if (depth > MAX_NESTING) {
    const error = new RangeError(`Brace or parenthesis nesting exceeds ${MAX_NESTING}`);
    error.code = 'BRACES_NESTING_LIMIT';
    throw error;
  }
};

const invalidAst = () => {
  const error = new TypeError('Invalid or cyclic braces AST');
  error.code = 'BRACES_INVALID_AST';
  throw error;
};

// An external/detached ancestor can carry an expansion queue. Parser cleanup
// legitimately leaves detached parents for unmatched groups, so do not reject
// all such links. Bound the arrays expand's append/flatten will consume instead.
const assertQueue = queue => {
  const arrays = new Set();
  const pending = [{ value: queue, depth: 0 }];
  while (pending.length > 0) {
    const { value, depth } = pending.pop();
    if (value === undefined || typeof value === 'string') continue;
    if (!Array.isArray(value) || arrays.has(value)) invalidAst();
    arrays.add(value);
    assertNesting(depth);
    for (let index = value.length - 1; index >= 0; index--) {
      pending.push({ value: value[index], depth: depth + 1 });
    }
  }
};

// expand() also walks parent links until reaching a brace/root. Parsed ASTs
// contain legitimate parent/prev backreferences, so do not recursively visit
// every object property or mistake those backreferences for child cycles.
const assertParentWalk = node => {
  const visited = new Set();
  let depth = 0;
  while (true) {
    assertQueue(node.queue);
    if (node.type === 'brace' || node.type === 'root' || !node.parent) break;
    if (visited.has(node)) invalidAst();
    visited.add(node);
    // The leaf-to-parent edge is additional to the container nesting depth.
    assertNesting(++depth - 1);
    node = node.parent;
    if (typeof node !== 'object' || node === null) invalidAst();
  }
};

// Public compile/expand/stringify accept caller-supplied ASTs, and their lib/
// modules are directly importable. Validate each entry point before invoking
// its recursive walker; guarding parse() alone would leave those paths open.
// Use an explicit stack so validation itself cannot overflow on hostile ASTs.
const assertAst = ast => {
  const visited = new Set();
  const stack = [{ node: ast, depth: ast && ast.type === 'root' ? -1 : 0 }];

  while (stack.length > 0) {
    const frame = stack.pop();
    const node = frame.node;
    // A parsed AST is a tree along child edges. Reject repeated child objects,
    // not only active cycles: a tiny shared DAG can expand into exponential
    // validation/walker work even when its nesting is below the limit.
    if (typeof node !== 'object' || node === null || visited.has(node)) invalidAst();
    visited.add(node);
    // Parser-produced values are strings. Arrays here can otherwise reach
    // expand's recursive append/flatten helpers without any AST child edge.
    if (node.value !== undefined && typeof node.value !== 'string') invalidAst();
    assertParentWalk(node);
    if (node.nodes === undefined) continue;
    if (!Array.isArray(node.nodes)) invalidAst();

    const depth = frame.depth + 1;
    assertNesting(depth);
    for (let index = node.nodes.length - 1; index >= 0; index--) {
      stack.push({ node: node.nodes[index], depth, parent: node });
    }
  }
};

module.exports = { MAX_NESTING, assertNesting, assertAst };
