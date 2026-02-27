/**
 * Strongly Connected Components (SCC) via Tarjan's algorithm,
 * graph condensation into a DAG, and topological sort via Kahn's algorithm.
 *
 * Used to detect circular dependencies and provide accurate cascade-level
 * impact analysis on the condensed (acyclic) dependency graph.
 */

import { DependencyGraph } from "../graph";

// ── Public Interfaces ──

export interface SCCResult {
  /** Each SCC as an array of absolute file paths */
  components: string[][];
  /** Maps each file to its SCC index in `components` */
  nodeToComponent: Map<string, number>;
  /** The condensed DAG built from the SCCs */
  condensed: CondensedDAG;
}

export interface CondensedDAG {
  /** One node per SCC */
  nodes: CondensedNode[];
  /** SCC index -> list of SCC indices that depend on it (forward = same direction as file imports) */
  forward: Map<number, number[]>;
  /** SCC index -> list of SCC indices it depends on */
  reverse: Map<number, number[]>;
  /** SCCs in topological order (dependencies before dependents) */
  topologicalOrder: number[];
}

export interface CondensedNode {
  /** Index in the `nodes` array, matches the SCC index */
  index: number;
  /** Absolute file paths belonging to this SCC */
  files: string[];
  /** Number of files in this SCC */
  size: number;
  /** True if this SCC has more than one file (circular dependency) */
  isCyclic: boolean;
}

// ── Tarjan's SCC Algorithm ──

/**
 * Compute all Strongly Connected Components of the dependency graph
 * using Tarjan's algorithm. Returns SCCs, a file-to-SCC mapping,
 * and the condensed DAG with topological ordering.
 */
export function computeSCC(graph: DependencyGraph): SCCResult {
  // Handle empty graph
  if (graph.files.size === 0) {
    const emptyDAG: CondensedDAG = {
      nodes: [],
      forward: new Map(),
      reverse: new Map(),
      topologicalOrder: [],
    };
    return {
      components: [],
      nodeToComponent: new Map(),
      condensed: emptyDAG,
    };
  }

  const components: string[][] = [];

  // Tarjan state
  let indexCounter = 0;
  const nodeIndex = new Map<string, number>();
  const nodeLowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];

  function strongConnect(node: string): void {
    nodeIndex.set(node, indexCounter);
    nodeLowlink.set(node, indexCounter);
    indexCounter++;
    stack.push(node);
    onStack.add(node);

    const successors = graph.forward.get(node) || [];
    for (const successor of successors) {
      // Only process nodes that exist in the graph
      if (!graph.files.has(successor)) continue;

      if (!nodeIndex.has(successor)) {
        // Successor not yet visited — recurse
        strongConnect(successor);
        nodeLowlink.set(
          node,
          Math.min(nodeLowlink.get(node)!, nodeLowlink.get(successor)!)
        );
      } else if (onStack.has(successor)) {
        // Successor is on the stack — part of current SCC
        nodeLowlink.set(
          node,
          Math.min(nodeLowlink.get(node)!, nodeIndex.get(successor)!)
        );
      }
    }

    // If node is a root of an SCC, pop the stack to form a component
    if (nodeLowlink.get(node) === nodeIndex.get(node)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== node);
      components.push(component);
    }
  }

  // Visit all nodes (handles disconnected components)
  for (const file of graph.files) {
    if (!nodeIndex.has(file)) {
      strongConnect(file);
    }
  }

  // Build file-to-component mapping
  const nodeToComponent = new Map<string, number>();
  for (let i = 0; i < components.length; i++) {
    for (const file of components[i]) {
      nodeToComponent.set(file, i);
    }
  }

  // Build the condensed DAG
  const condensed = condenseGraph(graph, components, nodeToComponent);

  return { components, nodeToComponent, condensed };
}

// ── Graph Condensation ──

/**
 * Build a DAG where each node represents one SCC.
 * Edges between SCCs are derived from the original graph's edges
 * between files belonging to different SCCs.
 */
export function condenseGraph(
  graph: DependencyGraph,
  components: string[][],
  nodeToComponent: Map<string, number>
): CondensedDAG {
  const numComponents = components.length;

  // Build condensed nodes
  const nodes: CondensedNode[] = components.map((files, index) => ({
    index,
    files,
    size: files.length,
    isCyclic: files.length > 1,
  }));

  // Build forward and reverse edges between SCCs (deduplicated)
  const forwardSets = new Map<number, Set<number>>();
  const reverseSets = new Map<number, Set<number>>();

  for (let i = 0; i < numComponents; i++) {
    forwardSets.set(i, new Set());
    reverseSets.set(i, new Set());
  }

  for (const [file, deps] of graph.forward) {
    const srcSCC = nodeToComponent.get(file);
    if (srcSCC === undefined) continue;

    for (const dep of deps) {
      const dstSCC = nodeToComponent.get(dep);
      if (dstSCC === undefined) continue;

      // Skip self-edges (within the same SCC)
      if (srcSCC === dstSCC) continue;

      forwardSets.get(srcSCC)!.add(dstSCC);
      reverseSets.get(dstSCC)!.add(srcSCC);
    }
  }

  // Convert sets to arrays
  const forward = new Map<number, number[]>();
  const reverse = new Map<number, number[]>();

  for (const [key, set] of forwardSets) {
    forward.set(key, [...set]);
  }
  for (const [key, set] of reverseSets) {
    reverse.set(key, [...set]);
  }

  const dag: CondensedDAG = {
    nodes,
    forward,
    reverse,
    topologicalOrder: [],
  };

  // Compute topological order
  dag.topologicalOrder = topologicalSort(dag);

  return dag;
}

// ── Topological Sort (Kahn's Algorithm) ──

/**
 * Compute a topological ordering of the condensed DAG using Kahn's algorithm.
 * The condensed graph is guaranteed to be acyclic after SCC condensation.
 *
 * Returns SCC indices in dependency order: dependencies come before dependents.
 * This uses the `forward` edges (file A imports B means A -> B in forward),
 * so we process nodes with no incoming forward edges first (leaf dependencies).
 */
export function topologicalSort(dag: CondensedDAG): number[] {
  const numNodes = dag.nodes.length;
  if (numNodes === 0) return [];

  // In-degree = number of dependencies (forward edges out of each node).
  // forward[A] = [B] means A imports B, so A depends on B.
  // For "dependencies first" ordering, nodes with zero dependencies come first.
  const inDegree = new Map<number, number>();
  for (let i = 0; i < numNodes; i++) {
    inDegree.set(i, 0);
  }

  for (const [src, dsts] of dag.forward) {
    inDegree.set(src, (inDegree.get(src) || 0) + dsts.length);
  }

  // Start with nodes that have no dependencies (in-degree 0 in forward)
  const queue: number[] = [];
  for (const [node, degree] of inDegree) {
    if (degree === 0) {
      queue.push(node);
    }
  }

  const order: number[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    // current has no remaining dependencies.
    // For all nodes that depend on current (reverse edges: who imports current),
    // decrement their in-degree.
    const dependents = dag.reverse.get(current) || [];
    for (const dependent of dependents) {
      const newDegree = (inDegree.get(dependent) || 0) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) {
        queue.push(dependent);
      }
    }
  }

  // If order doesn't contain all nodes, there's a bug (shouldn't happen after SCC condensation)
  if (order.length !== numNodes) {
    console.error(
      `[syke:scc] WARNING: Topological sort produced ${order.length}/${numNodes} nodes. ` +
      `This indicates a bug in SCC condensation.`
    );
    // Add remaining nodes at the end
    const ordered = new Set(order);
    for (let i = 0; i < numNodes; i++) {
      if (!ordered.has(i)) {
        order.push(i);
      }
    }
  }

  return order;
}
