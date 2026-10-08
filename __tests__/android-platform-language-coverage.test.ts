import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodeGraph } from '../src';
import { scanDirectory, buildScopeIgnore } from '../src/extraction';
import { clearProjectConfigCache } from '../src/project-config';
import { parseAidlDeclarations, findAidlImpl } from '../src/aosp/aidl';
import { parseHalDeclarations } from '../src/aosp/hal';
import { gateLanguageMatch, isVisibleAcrossFiles } from '../src/resolution/name-matcher';
import type { ResolutionContext } from '../src/resolution';
import type { UnresolvedRef } from '../src/resolution/types';

// Count source opens while keeping real filesystem and database operations.
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

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
    vi.restoreAllMocks();
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('indexes explicitly included vendor implementations while keeping dependency dirs ignored', async () => {
    write('vendor/oem/IVendor.aidl', 'package oem; interface IVendor { void run(); }');
    write('vendor/oem/VendorStub.java', 'package oem; public class VendorStub extends IVendor.Stub { public void run() {} }');
    write('vendor/oem/node_modules/noise.js', 'function noise() {}');
    write('vendor/oem/tool/vendor/dependency/Noise.java', 'public class Noise {}');
    write('.gitignore', 'vendor/\n');
    expect(scanDirectory(dir)).not.toContain('vendor/oem/VendorStub.java');
    write('codegraph.json', JSON.stringify({ include: ['vendor/'] }));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
    clearProjectConfigCache();
    expect(scanDirectory(dir)).toContain('vendor/oem/VendorStub.java');
    expect(scanDirectory(dir)).not.toContain('vendor/oem/node_modules/noise.js');
    expect(scanDirectory(dir)).not.toContain('vendor/oem/tool/vendor/dependency/Noise.java');
    expect(buildScopeIgnore(dir).ignores('vendor/oem/VendorStub.java')).toBe(false);
    cg = await CodeGraph.init(dir, { index: true });
    expect(cg.getNodesByName('VendorStub').length).toBeGreaterThan(0);
    expect(findAidlImpl(cg, dir, 'IVendor').status).toBe('found');
    write('vendor/oem/VendorStub.java', 'package oem; public class VendorStub extends IVendor.Stub { public void run() {} public void added() {} }');
    expect(cg.getChangedFiles().modified).toContain('vendor/oem/VendorStub.java');
    fs.rmSync(path.join(dir, 'vendor/oem/VendorStub.java'));
    expect(cg.getChangedFiles().removed).toContain('vendor/oem/VendorStub.java');
  });

  it.each(['vendor/', 'vendor/oem/', 'vendor/**/*.java'])(
    'keeps nested dependency trees excluded with include %s', (include) => {
      const source = 'public class VendorSource {}';
      const allowed = 'vendor/oem/VendorSource.java';
      const dependencies = [
        'vendor/oem/tool/vendor/dependency/Noise.java',
        'vendor/vendor/Noise.java',
        'packages/tool/vendor/Noise.java',
        'vendor/oem/node_modules/Noise.java',
        'vendor/oem/dist/Noise.java',
      ];
      write(allowed, source);
      for (const file of dependencies) write(file, source);
      write('vendor/oem/excluded/Noise.java', source);
      write('codegraph.json', JSON.stringify({ include: [include], exclude: ['vendor/oem/excluded/'] }));
      clearProjectConfigCache();
      const files = scanDirectory(dir);
      const scope = buildScopeIgnore(dir);
      expect(files).toContain(allowed);
      expect(scope.ignores(allowed)).toBe(false);
      for (const file of [...dependencies, 'vendor/oem/excluded/Noise.java']) {
        expect(files).not.toContain(file);
        expect(scope.ignores(file)).toBe(true);
      }
    },
  );

  it('does not read unchanged included source during git status checks', async () => {
    const file = 'vendor/oem/Device.java';
    const source = 'package oem; public class Device { public void run() {} }';
    write(file, source);
    write('src/Tracked.java', 'public class Tracked { void run() {} }');
    write('.gitignore', 'vendor/\n');
    write('codegraph.json', JSON.stringify({ include: ['vendor/'] }));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir });
    clearProjectConfigCache();
    cg = await CodeGraph.init(dir, { index: true });
    const opened = vi.mocked(fs.openSync);
    const sourceOpens = () => opened.mock.calls.filter(([name]) => String(name) === path.join(dir, file));
    opened.mockClear();
    expect(cg.getChangedFiles()).toEqual({ added: [], modified: [], removed: [] });
    expect(sourceOpens()).toHaveLength(0);

    // A metadata-only change still hashes once to confirm identical content.
    const stat = fs.statSync(path.join(dir, file));
    fs.utimesSync(path.join(dir, file), stat.atime, new Date(stat.mtimeMs + 2000));
    opened.mockClear();
    expect(cg.getChangedFiles().modified).toEqual([]);
    expect(sourceOpens()).toHaveLength(1);
    write(file, source.replace('run()', 'stop()')); // Same size, new mtime.
    fs.utimesSync(path.join(dir, file), stat.atime, new Date(stat.mtimeMs + 4000));
    expect(cg.getChangedFiles().modified).toEqual([file]);
    await cg.sync();
    // Git evidence must still win even when content changes preserve metadata.
    const tracked = path.join(dir, 'src/Tracked.java');
    const trackedStat = fs.statSync(tracked);
    write('src/Tracked.java', 'public class Tracked { void end() {} }');
    execFileSync('git', ['add', 'src/Tracked.java'], { cwd: dir });
    fs.utimesSync(tracked, trackedStat.atime, trackedStat.mtime);
    expect(cg.getChangedFiles().modified).toEqual(['src/Tracked.java']);
    write('vendor/oem/New.java', 'package oem; public class New {}');
    expect(cg.getChangedFiles().added).toEqual(['vendor/oem/New.java']);
    fs.rmSync(path.join(dir, file));
    expect(cg.getChangedFiles().removed).toEqual([file]);
  });

  it('allows cross-package calls through implicitly public nested Java interfaces', async () => {
    write('p/Outer.java', `package p;
public interface Outer {
  interface Inner {
    static void api() {}
    interface Deep { static void deepApi() {} }
    private static void hidden() {}
  }
}`);
    write('p/Closed.java', 'package p; interface Closed { interface Inner { static void closedApi() {} } }');
    write('q/Caller.java', `package q;
import p.Outer;
public class Caller {
  void run() {
    Outer.Inner.api();
    Outer.Inner.Deep.deepApi();
  }
}`);
    cg = await CodeGraph.init(dir, { index: true });
    const nodes = [...cg.getNodesByKind('interface'), ...cg.getNodesByKind('method'), ...cg.getNodesByKind('namespace')];
    const context = { getNodesInFile: (file: string) => nodes.filter((node) => node.filePath === file) } as ResolutionContext;
    const ref = { filePath: 'q/Caller.java', language: 'java' } as UnresolvedRef;
    for (const name of ['api', 'deepApi']) {
      const method = cg.getNodesByName(name).find((n) => n.kind === 'method')!;
      expect(isVisibleAcrossFiles(method, ref, context)).toBe(true);
      expect(cg.getCallers(method.id).map((c) => c.node.filePath)).toContain('q/Caller.java');
    }
    for (const name of ['hidden', 'closedApi']) {
      const method = cg.getNodesByName(name).find((n) => n.kind === 'method')!;
      expect(isVisibleAcrossFiles(method, ref, context)).toBe(false);
    }
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
    const nodes = [...cg.getNodesByKind('method'), ...cg.getNodesByKind('class'), ...cg.getNodesByKind('interface'), ...cg.getNodesByKind('namespace')];
    const context = {
      getNodesInFile: (file: string) => nodes.filter((node) => node.filePath === file),
      getNodeById: (id: string) => nodes.find((node) => node.id === id) ?? null,
    } as ResolutionContext;
    const ref = { filePath: 'q/Other.java', language: 'java', referenceName: 'hidden', referenceKind: 'calls' } as UnresolvedRef;
    expect(gateLanguageMatch({ original: ref, targetNodeId: hidden.id, confidence: 1, resolvedBy: 'import' }, ref, context)).toBeNull();
    expect(isVisibleAcrossFiles(api, { filePath: 'q/Other.java', language: 'java' } as UnresolvedRef, context)).toBe(true);
  });
});
