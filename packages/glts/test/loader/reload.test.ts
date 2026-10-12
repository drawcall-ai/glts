import { expect, it, vi } from "vitest";
import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial } from "three";
import { reloadRecords } from "../../src/loader/reload.js";
import { ScriptModules } from "../../src/modules/scripts.js";
import { Execution } from "../../src/scene/execution.js";
import { ManagedNodes, type NodeRecord } from "../../src/scene/nodes.js";
import { context } from "../scene/context.js";

/** Reloads `record` into `next`, exercising reload orchestration without browser imports. */
async function reload(record: NodeRecord, next: Execution): Promise<void> {
  const modules = new ScriptModules({
    cdnURL: new URL("https://cdn.test/"),
    fetch: async () => new Response("")
  });
  try {
    await reloadRecords(record.url, [record], modules, async () => next);
  } finally {
    modules.dispose();
  }
}

function errorCauses(error: unknown): unknown[] {
  const causes: unknown[] = [error];
  if (error instanceof AggregateError) causes.push(...error.errors.flatMap(errorCauses));
  if (error instanceof Error && error.cause !== undefined) causes.push(...errorCauses(error.cause));
  return causes;
}

it.each(["node", "registry"])("cleans a replacement when old cleanup disposes its %s", async (target) => {
  const url = "https://example.test/scene.glts";
  const matrices = [new Matrix4()];
  const nodes = new ManagedNodes();
  const previous = new Execution(matrices, [url], (root, owned) => nodes.disposeNested(root, owned));
  const next = new Execution(matrices, [url], (root, owned) => nodes.disposeNested(root, owned));
  const node = nodes.createScene(previous, { url, matrices, isPreview: false, instances: false });
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
    await reload(record, next);
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

it("disposes automatic instance resources once when execution cleanup reenters the node", async () => {
  const url = "https://example.test/instances.glts";
  const matrices = [new Matrix4()];
  const nodes = new ManagedNodes();
  const previous = new Execution(matrices, [url], (root, owned) => nodes.disposeNested(root, owned));
  const geometry = new BoxGeometry();
  const material = new MeshBasicMaterial();
  previous.scene.add(new Mesh(geometry, material));
  previous.autoInstance(url);
  const node = nodes.createInstances(previous, { url, matrices, isPreview: false, instances: true });
  const disposed = vi.fn();
  node.traverse((object) => {
    if (object instanceof InstancedMesh) object.addEventListener("dispose", disposed);
  });
  context(previous).onDispose(() => node.dispose());
  const next = new Execution(matrices, [url], (root, owned) => nodes.disposeNested(root, owned));
  try {
    const failure = await reload(nodes.getRecord(node), next).catch((error: unknown) => error);
    expect(errorCauses(failure).some((error) =>
      error instanceof Error && error.message.includes("disposed during reload")))
      .toBe(true);
    expect(disposed).toHaveBeenCalledTimes(1);
  } finally {
    nodes.disposeAll();
    geometry.dispose();
    material.dispose();
  }
});

it("runs the previous execution's disposal callbacks with its children still attached", async () => {
  const url = "https://example.test/scene.glts";
  const matrices = [new Matrix4()];
  const nodes = new ManagedNodes();
  const previous = new Execution(matrices, [url], (root, owned) => nodes.disposeNested(root, owned));
  const next = new Execution(matrices, [url], (root, owned) => nodes.disposeNested(root, owned));
  const node = nodes.createScene(previous, { url, matrices, isPreview: false, instances: false });
  node.add(Object.assign(new Group(), { name: "previous" }));
  next.scene.add(Object.assign(new Group(), { name: "next" }));
  const hooks = context(previous);
  const seen: string[] = [];
  hooks.onDispose(() => hooks.scene.traverse((object) => {
    if (object !== hooks.scene) seen.push(object.name);
  }));

  await reload(nodes.getRecord(node), next);
  expect(seen).toEqual(["previous"]);
  expect(node.children.map(({ name }) => name)).toEqual(["next"]);
  nodes.disposeAll();
});
