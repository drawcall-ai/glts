import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";

import { ModuleURLStore } from "./module-url-store.js";
import { WrapperRuntime } from "./runtime.js";

describe("WrapperRuntime", () => {
  let runtime: WrapperRuntime | undefined;

  afterEach(() => {
    runtime?.dispose();
    runtime = undefined;
  });

  it("replaces the raw instance without replacing its wrapper", () => {
    const moduleURLs = new ModuleURLStore();
    runtime = new WrapperRuntime(moduleURLs);
    const url = "https://example.test/tree.glts";

    class FirstTree extends THREE.Group {
      disposed = false;

      dispose(): void {
        this.disposed = true;
      }
    }

    class SecondTree extends THREE.Group {}

    runtime.setAssetClass(url, FirstTree);
    const wrapper = runtime.createRoot(url);
    expect(wrapper.name).toBe(url);
    const first = wrapper.children[0];
    if (!(first instanceof FirstTree)) {
      throw new Error("Expected the first tree instance");
    }

    runtime.replace(url, SecondTree);

    expect(wrapper.children).toHaveLength(1);
    expect(wrapper.children[0]).toBeInstanceOf(SecondTree);
    expect(first.disposed).toBe(true);
  });

  it("reloads nested assets inside their existing component wrapper", () => {
    const moduleURLs = new ModuleURLStore();
    runtime = new WrapperRuntime(moduleURLs);
    const parentURL = "https://example.test/tree.glts";
    const childURL = "https://example.test/branch.glts";

    class FirstBranch extends THREE.Group {}
    class SecondBranch extends THREE.Group {}

    runtime.setAssetClass(childURL, FirstBranch);
    const Branch = runtime.getWrapperConstructor(childURL);

    class Tree extends THREE.Group {
      constructor() {
        super();
        this.add(new Branch());
      }
    }

    runtime.setAssetClass(parentURL, Tree);
    const rootWrapper = runtime.createRoot(parentURL);
    expect(rootWrapper.name).toBe(parentURL);
    const tree = rootWrapper.children[0];
    if (!(tree instanceof THREE.Group)) {
      throw new Error("Expected a tree instance");
    }
    const branchWrapper = tree.children[0];
    if (!(branchWrapper instanceof THREE.Group)) {
      throw new Error("Expected a branch wrapper");
    }
    expect(branchWrapper.name).toBe(childURL);

    runtime.replace(childURL, SecondBranch);

    expect(rootWrapper.children[0]).toBe(tree);
    expect(tree.children[0]).toBe(branchWrapper);
    expect(branchWrapper.children[0]).toBeInstanceOf(SecondBranch);
  });

  it("keeps every old instance mounted after a failed replacement", () => {
    const moduleURLs = new ModuleURLStore();
    runtime = new WrapperRuntime(moduleURLs);
    const url = "https://example.test/tree.glts";

    class WorkingTree extends THREE.Group {
      disposed = false;

      dispose(): void {
        this.disposed = true;
      }
    }

    class BrokenTree extends THREE.Group {
      constructor() {
        super();
        throw new Error("broken constructor");
      }
    }

    runtime.setAssetClass(url, WorkingTree);
    const firstWrapper = runtime.createRoot(url);
    const secondWrapper = runtime.createRoot(url);
    const first = firstWrapper.children[0];
    const second = secondWrapper.children[0];
    if (!(first instanceof WorkingTree) || !(second instanceof WorkingTree)) {
      throw new Error("Expected working tree instances");
    }

    expect(() => runtime?.replace(url, BrokenTree)).toThrow(
      "Default export failed during construction"
    );
    expect(firstWrapper.children[0]).toBe(first);
    expect(secondWrapper.children[0]).toBe(second);
    expect(first.disposed).toBe(false);
    expect(second.disposed).toBe(false);

    const thirdWrapper = runtime.createRoot(url);
    expect(thirdWrapper.children[0]).toBeInstanceOf(WorkingTree);
  });

  it("recursively disposes nested GLTS wrappers", () => {
    const moduleURLs = new ModuleURLStore();
    runtime = new WrapperRuntime(moduleURLs);
    const parentURL = "https://example.test/tree.glts";
    const childURL = "https://example.test/branch.glts";
    let childDisposals = 0;
    let parentDisposals = 0;

    class Branch extends THREE.Group {
      dispose(): void {
        childDisposals += 1;
      }
    }

    runtime.setAssetClass(childURL, Branch);
    const BranchWrapper = runtime.getWrapperConstructor(childURL);

    class Tree extends THREE.Group {
      constructor() {
        super();
        this.add(new BranchWrapper());
      }

      dispose(): void {
        parentDisposals += 1;
      }
    }

    runtime.setAssetClass(parentURL, Tree);
    const wrapper = runtime.createRoot(parentURL);
    runtime.disposeWrapper(wrapper);

    expect(childDisposals).toBe(1);
    expect(parentDisposals).toBe(1);
  });

  it("constructs a root synchronously and waits for its resources", async () => {
    const moduleURLs = new ModuleURLStore();
    const activeRuntime = new WrapperRuntime(moduleURLs);
    runtime = activeRuntime;
    const url = "https://example.test/tree.glts";
    let finish: (() => void) | undefined;
    let constructions = 0;

    class Tree extends THREE.Group {
      constructor() {
        super();
        constructions += 1;
        activeRuntime.loadingManager.itemStart("https://example.test/bark.png");
        finish = () => activeRuntime.loadingManager.itemEnd("https://example.test/bark.png");
      }
    }

    activeRuntime.setAssetClass(url, Tree);
    const loading = activeRuntime.loadRoot(url);
    expect(constructions).toBe(1);

    let settled = false;
    void loading.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    if (!finish) {
      throw new Error("Expected the resource completion callback");
    }

    finish();
    const wrapper = await loading;
    expect(wrapper.children[0]).toBeInstanceOf(Tree);
  });

  it("disposes a constructed root when its resource load fails", async () => {
    const moduleURLs = new ModuleURLStore();
    const activeRuntime = new WrapperRuntime(moduleURLs);
    runtime = activeRuntime;
    const url = "https://example.test/tree.glts";
    const resourceURL = "https://example.test/missing.png";
    let disposals = 0;

    class Tree extends THREE.Group {
      constructor() {
        super();
        activeRuntime.loadingManager.itemStart(resourceURL);
        activeRuntime.loadingManager.itemError(resourceURL);
        activeRuntime.loadingManager.itemEnd(resourceURL);
      }

      dispose(): void {
        disposals += 1;
      }
    }

    activeRuntime.setAssetClass(url, Tree);
    await expect(activeRuntime.loadRoot(url)).rejects.toMatchObject({
      phase: "resource",
      url
    });
    expect(disposals).toBe(1);
  });

  it("keeps nested construction and replacement synchronous", () => {
    const moduleURLs = new ModuleURLStore();
    const activeRuntime = new WrapperRuntime(moduleURLs);
    runtime = activeRuntime;
    const parentURL = "https://example.test/tree.glts";
    const childURL = "https://example.test/branch.glts";
    let finish: (() => void) | undefined;

    class FirstBranch extends THREE.Group {}
    class SecondBranch extends THREE.Group {
      constructor() {
        super();
        activeRuntime.loadingManager.itemStart("https://example.test/leaf.png");
        finish = () => activeRuntime.loadingManager.itemEnd("https://example.test/leaf.png");
      }
    }

    activeRuntime.setAssetClass(childURL, FirstBranch);
    const Branch = activeRuntime.getWrapperConstructor(childURL);
    class Tree extends THREE.Group {
      constructor() {
        super();
        this.add(new Branch());
      }
    }

    activeRuntime.setAssetClass(parentURL, Tree);
    const root = activeRuntime.createRoot(parentURL);
    const branch = root.children[0]?.children[0];
    activeRuntime.replace(childURL, SecondBranch);

    expect(root.children[0]?.children[0]).toBe(branch);
    expect(branch?.children[0]).toBeInstanceOf(SecondBranch);
    if (!finish) {
      throw new Error("Expected replacement to start its resource");
    }
    finish();
  });

  it("gives each wrapper runtime its own loading manager", () => {
    const first = new WrapperRuntime(new ModuleURLStore());
    const second = new WrapperRuntime(new ModuleURLStore());

    try {
      expect(first.loadingManager).not.toBe(second.loadingManager);
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});
