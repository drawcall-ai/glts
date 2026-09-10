import { expect, it, vi } from "vitest";
import { BoxGeometry, Group, InstancedMesh, LoadingManager, Matrix4, Mesh, MeshBasicMaterial } from "three";
import { reloadRecords } from "../../src/loader/reload.js";
import { Construction } from "../../src/loader/construction.js";
import { Operations } from "../../src/loader/operations.js";
import { ScriptModules } from "../../src/modules/scripts.js";
import { ModuleBridge } from "../../src/modules/bridge.js";
import { ModuleURLStore } from "../../src/modules/urls.js";
import { Execution } from "../../src/scene/execution.js";
import { createAutoInstances } from "../../src/scene/instances.js";
import { ManagedNodes, type NodeRecord } from "../../src/scene/registry.js";

function context(execution: Execution) {
  return execution.context({
    gltsLoader: {
      loadAsync: async () => { throw new Error("Unexpected nested load"); },
      loadInstancesAsync: async () => { throw new Error("Unexpected nested load"); }
    },
    loadingManager: new LoadingManager(),
    isPreview: false
  });
}

async function reload(nodes: ManagedNodes, record: NodeRecord, next: Execution): Promise<void> {
  const manager = new LoadingManager();
  const moduleURLs = new ModuleURLStore();
  const bridge = new ModuleBridge(moduleURLs);
  const modules = new ScriptModules({
    cdnURL: new URL("https://cdn.test/"),
    fetch: async () => new Response(""),
    moduleURLs,
    bridge,
    threeRevision: "185"
  });
  const operations = new Operations(manager);
  const construction = new Construction({
    contextLoader: (execution) => context(execution).gltsLoader,
    manager, modules, nodes, operations, physicsWorld: undefined
  });
  // Exercise reload orchestration with a prepared revision, without browser imports.
  vi.spyOn(construction, "execute").mockResolvedValue(nodes.createRevision(next));
  try {
    await reloadRecords(record.url, [record], { modules, nodes, construction, operations });
  } finally {
    construction.dispose();
    operations.dispose();
    bridge.dispose();
  }
}

function errorCauses(error: unknown): unknown[] {
  const causes: unknown[] = [error];
  if (error instanceof AggregateError) causes.push(...error.errors.flatMap(errorCauses));
  if (error instanceof Error && error.cause !== undefined) causes.push(...errorCauses(error.cause));
  return causes;
}

it("rejects physics introduced by nested reload inside an instanced asset before replacement", async () => {
  const nodes = new ManagedNodes(async () => {});
  const matrices = [new Matrix4()];
  const parent = new Execution(matrices, ["https://example.test/parent.glts"]);
  const child = new Execution(matrices, ["https://example.test/child.glts"]);
  const parentNode = nodes.createInstances(
    nodes.createRevision(parent),
    "https://example.test/parent.glts",
    false,
    matrices,
  );
  const childNode = nodes.createScene(
    nodes.createRevision(child),
    "https://example.test/child.glts",
    false,
    matrices,
  );
  parentNode.add(childNode);
  const next = new Execution(matrices, [childNode.url]);
  context(next).declarePhysics();
  try {
    await expect(reload(nodes, nodes.getRecord(childNode), next))
      .rejects.toThrow("inside GLTS instances");
    expect(childNode.capabilities.physics).toBe(false);
    expect(childNode.parent).toBe(parentNode);
    parentNode.remove(childNode);
    const detached = new Execution(matrices, [childNode.url]);
    context(detached).declarePhysics();
    await expect(reload(nodes, nodes.getRecord(childNode), detached)).resolves.toBeUndefined();
    expect(childNode.capabilities.physics).toBe(true);
  } finally {
    next.dispose();
    nodes.disposeAll();
  }
});

it.each(["node", "registry"])("cleans a replacement when old cleanup disposes its %s", async (target) => {
  const url = "https://example.test/scene.glts";
  const matrices = [new Matrix4()];
  const nodes = new ManagedNodes(async () => {});
  const previous = new Execution(matrices, [url]);
  const next = new Execution(matrices, [url]);
  const node = nodes.createScene(nodes.createRevision(previous), url, false, matrices);
  const record = nodes.getRecord(node);
  const previousFailure = new Error("Previous cleanup failed");
  const nextFailure = new Error("Replacement cleanup failed");
  const disposePrevious = vi.fn(() => {
    node.add(new Group());
    if (target === "node") node.dispose();
    else nodes.disposeAll();
    throw previousFailure;
  });
  const disposeNext = vi.fn(() => { throw nextFailure; });
  context(previous).onDispose(disposePrevious);
  context(next).onDispose(disposeNext);
  next.scene.name = "replacement";

  let failure: unknown;
  try {
    await reload(nodes, record, next);
  } catch (error) {
    failure = error;
  }
  const causes = errorCauses(failure);
  expect(causes).toContain(previousFailure);
  expect(causes).toContain(nextFailure);
  expect(causes.some((error) => error instanceof Error && error.message.includes("GLTS node was disposed during reload"))).toBe(true);
  expect(disposePrevious).toHaveBeenCalledTimes(1);
  expect(disposeNext).toHaveBeenCalledTimes(1);
  expect(node.name).not.toBe("replacement");
  expect(node.children).toHaveLength(0);
  expect(record.disposed).toBe(true);
  expect(() => nodes.getRecord(node)).toThrow("disposed");
  nodes.disposeAll();
  expect(disposeNext).toHaveBeenCalledTimes(1);
});


it("disposes automatic instance resources once when revision cleanup reenters the node", async () => {
  const url = "https://example.test/instances.glts";
  const matrices = [new Matrix4()];
  const nodes = new ManagedNodes(async () => {});
  const previous = new Execution(matrices, [url]);
  const geometry = new BoxGeometry();
  const material = new MeshBasicMaterial();
  previous.scene.add(new Mesh(geometry, material));
  const automatic = createAutoInstances(previous.scene, matrices, url);
  const node = nodes.createInstances(nodes.createRevision(previous, automatic), url, false, matrices);
  const disposed = vi.fn();
  node.traverse((object) => {
    if (object instanceof InstancedMesh) object.addEventListener("dispose", disposed);
  });
  context(previous).onDispose(() => node.dispose());
  const next = new Execution(matrices, [url]);
  try {
    const failure = await reload(nodes, nodes.getRecord(node), next).catch((error: unknown) => error);
    expect(errorCauses(failure).some((error) =>
      error instanceof Error && error.message.includes("disposed during reload")))
      .toBe(true);
    expect(disposed).toHaveBeenCalledTimes(1);
    automatic.dispose();
    expect(disposed).toHaveBeenCalledTimes(1);
  } finally {
    nodes.disposeAll();
    geometry.dispose();
    material.dispose();
  }
});
