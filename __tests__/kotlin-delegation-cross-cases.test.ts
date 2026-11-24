import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('named and anonymous Kotlin delegation in one indexed project', () => {
  let root: string;
  let cg: CodeGraph;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-delegation-cross-'));
    const files = {
      'api/Repo.kt': 'package api\ninterface Repo { fun read(): String }\n',
      'decoy/Repo.kt': 'package decoy\ninterface Repo { fun read(): String }\n',
      'hidden/InvisibleRepo.kt': 'package hidden\ninterface InvisibleRepo { fun read(): String }\n',
      'app/Main.kt': `package app
import api.Repo
class Named(inner: Repo) : Repo by inner { override fun read() = "named" }
fun create(inner: Repo) = object : Repo by inner { override fun read() = "anonymous" }
class Missing(inner: InvisibleRepo) : InvisibleRepo by inner
`,
    };
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    cg = await CodeGraph.init(root, { index: true });
  });
  afterAll(() => { cg?.close(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('links each implementation exactly once to the imported interface', () => {
    const nodes = cg.getNodesInFile('app/Main.kt');
    const implementations = nodes.filter(n => n.name === 'Named' || n.name.includes('$anon@'));
    expect(implementations).toHaveLength(2);
    for (const n of implementations) {
      const targets = cg.getOutgoingEdges(n.id).filter(e => e.kind === 'implements' || e.kind === 'extends')
        .map(e => cg.getNode(e.target)!.qualifiedName);
      expect(targets, n.qualifiedName).toEqual(['api::Repo']);
    }
  });

  it('does not guess an unimported foreign interface for a delegated supertype', () => {
    const missing = cg.getNodesInFile('app/Main.kt').find(n => n.name === 'Missing')!;
    expect(missing).toBeDefined();
    expect(cg.getOutgoingEdges(missing.id).filter(e => e.kind === 'implements' || e.kind === 'extends')).toEqual([]);
  });
});
