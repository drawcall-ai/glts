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
    const tree = rootWrapper.children[0];
    if (!(tree instanceof THREE.Group)) {
      throw new Error("Expected a tree instance");
    }
    const branchWrapper = tree.children[0];
    if (!(branchWrapper instanceof THREE.Group)) {
      throw new Error("Expected a branch wrapper");
    }

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
});
