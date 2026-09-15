import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const graphPath = process.env.DEPENDENCY_GRAPH_PATH
  ? path.resolve(root, process.env.DEPENDENCY_GRAPH_PATH)
  : path.join(root, 'dependencies', 'graph.json');
const graph = JSON.parse(await readFile(graphPath, 'utf8'));
const failures = [], ids = new Set();
if (graph.schemaVersion !== 1 || !Array.isArray(graph.edges)) failures.push('Invalid graph schema.');
for (const edge of graph.edges ?? []) {
  if (!edge.id || ids.has(edge.id)) failures.push(`Missing or duplicate edge id: ${edge.id ?? '(none)'}`);
  ids.add(edge.id);
  if (!edge.target || !edge.kind || !Array.isArray(edge.requiredPatterns) || !edge.requiredPatterns.length) failures.push(`Incomplete edge: ${edge.id}`);
  for (const proof of edge.requiredPatterns ?? []) {
    const file = path.resolve(root, proof.file ?? '');
    try { await stat(file); } catch { failures.push(`${edge.id}: evidence file missing: ${proof.file}`); continue; }
    if (!(await readFile(file, 'utf8')).includes(proof.pattern)) failures.push(`${edge.id}: required evidence drifted in ${proof.file}: ${proof.pattern}`);
  }
}
if (failures.length) { console.error('Dependency graph check failed:\n- ' + failures.join('\n- ')); process.exit(1); }
console.log(`Dependency graph verified: ${graph.edges.length} edges.`);
