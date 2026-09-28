import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodeGraph } from '../src';
import { scanDirectory, buildScopeIgnore } from '../src/extraction';
import { clearProjectConfigCache } from '../src/project-config';
import { parseAidlDeclarations, findAidlImpl } from '../src/aosp/aidl';
import { parseHalDeclarations } from '../src/aosp/hal';
import { isVisibleAcrossFiles } from '../src/resolution/name-matcher';
import type { ResolutionContext } from '../src/resolution';
import type { UnresolvedRef } from '../src/resolution/types';

describe('Android source coverage', () => {
  let dir: string;
  let cg: CodeGraph | undefined;
  const write = (rel: string, source: string) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-android-source-'));
    clearProjectConfigCache();
  });
  afterEach(() => {
    cg?.destroy();
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('indexes explicitly included vendor implementations while keeping dependency dirs ignored', async () => {
    write('vendor/oem/IVendor.aidl', 'package oem; interface IVendor { void run(); }');
    write('vendor/oem/VendorStub.java', 'package oem; public class VendorStub extends IVendor.Stub { public void run() {} }');
    write('vendor/oem/node_modules/noise.js', 'function noise() {}');
    write('.gitignore', 'vendor/\n');
    expect(scanDirectory(dir)).not.toContain('vendor/oem/VendorStub.java');
    write('codegraph.json', JSON.stringify({ include: ['vendor/'] }));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
    clearProjectConfigCache();
    expect(scanDirectory(dir)).toContain('vendor/oem/VendorStub.java');
    expect(scanDirectory(dir)).not.toContain('vendor/oem/node_modules/noise.js');
    expect(buildScopeIgnore(dir).ignores('vendor/oem/VendorStub.java')).toBe(false);
    cg = await CodeGraph.init(dir, { index: true });
    expect(cg.getNodesByName('VendorStub').length).toBeGreaterThan(0);
    expect(findAidlImpl(cg, dir, 'IVendor').status).toBe('found');
    write('vendor/oem/VendorStub.java', 'package oem; public class VendorStub extends IVendor.Stub { public void run() {} public void added() {} }');
    expect(cg.getChangedFiles().modified).toContain('vendor/oem/VendorStub.java');
    fs.rmSync(path.join(dir, 'vendor/oem/VendorStub.java'));
    expect(cg.getChangedFiles().removed).toContain('vendor/oem/VendorStub.java');
  });

  it('extracts annotated AIDL return methods from public AOSP syntax', () => {
    write('hardware/interfaces/audio/IModule.aidl',
      'package android.hardware.audio.core;\ninterface IModule {\n  @nullable IBluetoothLe getBluetoothLe();\n  void reset();\n}');
    expect(parseAidlDeclarations(dir, 'IModule')[0]?.methods).toEqual(['getBluetoothLe', 'reset']);
    expect(parseHalDeclarations(dir, 'IModule', '.aidl')[0]?.methods).toEqual(['getBluetoothLe', 'reset']);
  });

  it('resolves generic Java supertypes without losing qualified nested names', async () => {
    write('Base.java', 'package p; public class Base<T> {}');
    write('Face.java', 'package p; public interface Face<T> {}');
    write('Outer.java', 'package p; public class Outer<T> { public class Inner<U> {} }');
    write('Derived.java', 'package p; public class Derived extends Base<String> implements Face<Integer> {}');
    write('Nested.java', 'package p; public class Nested extends Outer<String>.Inner<Integer> { Nested(Outer<String> o) { o.super(); } }');
    cg = await CodeGraph.init(dir, { index: true });
    const targets = (name: string) => {
      const id = cg!.getNodesByName(name).find((n) => n.kind === 'class')!.id;
      return cg!.getOutgoingEdges(id).filter((e) => e.kind === 'extends' || e.kind === 'implements')
        .map((e) => cg!.getNode(e.target)?.name);
    };
    expect(targets('Derived')).toEqual(expect.arrayContaining(['Base', 'Face']));
    expect(targets('Nested')).toContain('Inner');
  });

  it('indexes methods declared by Java enum constant class bodies', async () => {
    write('Mode.java', 'package p; enum Mode { ON { int level() { return 1; } }, OFF { int level() { return 0; } }; abstract int level(); }');
    cg = await CodeGraph.init(dir, { index: true });
    const methods = cg.getNodesByName('level').filter((n) => n.kind === 'method').map((n) => n.qualifiedName);
    expect(methods).toEqual(expect.arrayContaining(['p::Mode::ON::level', 'p::Mode::OFF::level', 'p::Mode::level']));
  });

  it('allows package-private static calls in the same Java package only', async () => {
    write('p/Utility.java', 'package p; public class Utility { static void hidden() {} public static void open() {} }');
    write('p/Contract.java', 'package p; public interface Contract { static void api() {} }');
    write('other/Same.java', 'package p; public class Same { void run() { Utility.hidden(); } }');
    write('q/Other.java', 'package q; import p.Utility; import p.Contract; public class Other { void run() { Utility.hidden(); Utility.open(); Contract.api(); } }');
    cg = await CodeGraph.init(dir, { index: true });
    const hidden = cg.getNodesByName('hidden').find((n) => n.kind === 'method')!;
    const open = cg.getNodesByName('open').find((n) => n.kind === 'method')!;
    const api = cg.getNodesByName('api').find((n) => n.kind === 'method')!;
    const callers = (id: string) => cg!.getCallers(id).map((c) => c.node.filePath);
    expect(callers(hidden.id)).toContain('other/Same.java');
    expect(callers(hidden.id)).not.toContain('q/Other.java');
    expect(callers(open.id)).toContain('q/Other.java');
    const nodes = [api, ...cg.getNodesByName('Contract'), ...cg.getNodesByKind('namespace')];
    const context = { getNodesInFile: (file: string) => nodes.filter((node) => node.filePath === file) } as ResolutionContext;
    expect(isVisibleAcrossFiles(api, { filePath: 'q/Other.java', language: 'java' } as UnresolvedRef, context)).toBe(true);
  });
});
