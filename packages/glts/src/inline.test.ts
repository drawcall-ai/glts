import { describe, expect, it } from "vitest";

import { compileTypeScript } from "./compiler.js";
import { GLTSError } from "./errors.js";
import { inline } from "./inline.js";
import { rewriteModule } from "./rewrite-module.js";

const groupModuleURL = `data:text/javascript,${encodeURIComponent(`
export class Group {
  children = [];
  name = "";

  add(child) {
    this.children.push(child);
    return this;
  }
}

export class PerspectiveCamera {}
export class AmbientLight {}
`)}`;

async function execute(source: string): Promise<Record<string, unknown>> {
  const sourceURL = "https://example.test/assets/tree.glts";
  const compiled = compileTypeScript(source);
  const runnable = await rewriteModule({
    source: compiled,
    sourceURL,
    importChain: [sourceURL],
    resolveImport: async (specifier) => {
      if (specifier !== "three") {
        throw new Error(`Unexpected test import: ${specifier}`);
      }

      return groupModuleURL;
    }
  });
  const url = `data:text/javascript,${encodeURIComponent(runnable)}`;
  return import(url);
}

describe("inline", () => {
  it("returns an entry without local imports unchanged", () => {
    const source = `import data from "./data.json" with { type: "json" };

const module = import("three");
const url = import.meta.url;

export { data, module, url };`;

    expect(inline(source, {})).toBe(source);
  });

  it("keeps the root body and collects dependency imports", () => {
    const body = `export default class Tree extends THREE.Group {
  branch = new Branch();
}`;
    const source = `import * as THREE from "three";
import Branch from "./branch.glts";

${body}`;

    const bundled = inline(source, {
      "./branch.glts": `import { Group } from "three";

export default class Branch extends Group {}`
    });

    expect(bundled).toContain('import * as THREE from "three";');
    expect(bundled).toContain('import { Group } from "three";');
    expect(bundled).toContain('import { Group as __glts_Group } from "three";');
    expect(bundled).toContain("class Branch extends Group {}");
    expect(bundled).toContain("const Branch = __glts_0;");
    expect(bundled).toContain(body);
    expect(() => compileTypeScript(bundled)).not.toThrow();
  });

  it("deduplicates bindings instead of rewriting namespace imports", () => {
    const bundled = inline(
      `import * as THREE from "three";
import { Group } from "three";
import Branch from "./branch.glts";

export default class Tree extends THREE.Group {
  branch = new Branch();
}`,
      {
        "./branch.glts": `import { Group, Mesh } from "three";

export default class Branch extends Group {
  mesh = Mesh;
}`
      }
    );

    expect(bundled.match(/import \* as THREE from "three";/g)).toHaveLength(1);
    expect(bundled.match(/import \{ Group \} from "three";/g)).toHaveLength(1);
    expect(bundled.match(/import \{ Mesh \} from "three";/g)).toHaveLength(1);
  });

  it("inlines nested files once in dependency order", () => {
    const bundled = inline(
      `import Branch from "./branch.glts";
import Leaf from "./leaf.glts";

export default class Tree {
  branch = new Branch();
  leaf = new Leaf();
}`,
      {
        "./branch.glts": `import Leaf from "./leaf.glts";

export default class Branch {
  leaf = new Leaf();
}`,
        "./leaf.glts": "export default class Leaf {}"
      }
    );

    expect(bundled.match(/class Leaf/g)).toHaveLength(1);
    expect(bundled.indexOf("class Leaf")).toBeLessThan(bundled.indexOf("class Branch"));
    expect(bundled).toContain("const Leaf = __glts_0;");
    expect(bundled).toContain("const Branch = __glts_1;");
  });

  it("preserves GLTS wrapper nesting and source names", async () => {
    const bundled = inline(
      `import * as THREE from "three";
import Branch from "./parts/branch.glts";

export default class Tree extends THREE.Group {
  constructor() {
    super();
    this.add(new Branch());
  }
}`,
      {
        "./parts/branch.glts": `import { Group } from "three";
import Leaf from "./leaf.glts";

export default class extends Group {
  constructor() {
    super();
    this.add(new Leaf());
  }
}`,
        "./parts/leaf.glts": `import { Group } from "three";

export default class Leaf extends Group {
  value: number = 42;
}`
      }
    );
    const module = await execute(bundled);
    const Tree = module.default;
    if (typeof Tree !== "function") {
      throw new Error("Expected the inline entry class");
    }

    const tree = Reflect.construct(Tree, []);
    const branchWrapper = tree.children[0];
    const branch = branchWrapper.children[0];
    const leafWrapper = branch.children[0];
    const leaf = leafWrapper.children[0];

    expect(tree.children).toHaveLength(1);
    expect(branchWrapper.name).toBe(
      "https://example.test/assets/parts/branch.glts"
    );
    expect(branchWrapper.children).toHaveLength(1);
    expect(branch.children).toHaveLength(1);
    expect(leafWrapper.name).toBe("https://example.test/assets/parts/leaf.glts");
    expect(leafWrapper.children).toHaveLength(1);
    expect(leaf.value).toBe(42);
  });

  it("keeps dependency preview exports out of the composable wrapper", async () => {
    const bundled = inline(
      `import { Group } from "three";
import Branch from "./branch.glts";

export default class Tree extends Group {
  constructor() {
    super();
    this.add(new Branch());
  }
}`,
      {
        "./branch.glts": `import { AmbientLight, Group, PerspectiveCamera } from "three";

export const previewCamera = new PerspectiveCamera();
const previewLighting = new Group();
previewLighting.add(new AmbientLight());
export { previewLighting };

export default class Branch extends Group {}`
      }
    );

    expect(bundled).not.toContain("export const previewCamera");
    expect(bundled).not.toContain("export { previewLighting }");

    const module = await execute(bundled);
    const Tree = module.default;
    if (typeof Tree !== "function") {
      throw new Error("Expected the inline entry class");
    }
    const tree = Reflect.construct(Tree, []);
    const branchWrapper = tree.children[0];
    const branch = branchWrapper.children[0];

    expect(branch.children).toEqual([]);
  });

  it("keeps TypeScript syntax and rewrites dependency import.meta.url", () => {
    const bundled = inline(
      `import Branch from "./parts/branch.glts";

export default class Tree {
  branch = new Branch();
}`,
      {
        "./parts/branch.glts": `interface Options<T> {
  value: T;
}

const source = new URL("./branch.png", import.meta.url);

export default class Branch<T = string> {
  options?: Options<T>;
  source = source;
}`
      }
    );

    expect(bundled).toContain("interface Options<T>");
    expect(bundled).toContain("class Branch<T = string>");
    expect(bundled).toContain(
      'new URL("./parts/branch.glts", import.meta.url).href'
    );
    expect(() => compileTypeScript(bundled)).not.toThrow();
  });

  it("keeps entry-only ESM syntax and imports that follow the body", () => {
    const bundled = inline(
      `const before = import("three");
import Branch from "./branch.glts";

export default class Tree {
  before = before;
  branch = new Branch();
}`,
      { "./branch.glts": "export default class Branch {}" }
    );

    expect(bundled).toContain('const before = import("three");');
    expect(bundled.indexOf("const __glts_0")).toBeLessThan(
      bundled.indexOf('const before = import("three");')
    );
  });

  it.each([
    ["relative", "../shared/branch.glts"],
    ["root-absolute", "/assets/branch.glts"],
    ["URL", "https://example.com/branch.glts"]
  ])("preserves a dependency's %s URL", (_name, path) => {
    const bundled = inline(
      `import Branch from ${JSON.stringify(path)}; export default Branch;`,
      {
        [path]: `const url = import.meta.url;
export default class Branch { url = url; }`
      }
    );

    expect(bundled).toContain(
      `new URL(${JSON.stringify(path)}, import.meta.url).href`
    );
  });

  it("allows TypeScript import types but rejects runtime dynamic imports", () => {
    expect(() =>
      inline('import Branch from "./branch.glts"; export default Branch;', {
        "./branch.glts": `type Group = import("three").Group;
export default class Branch {
  declare group: Group;
}`
      })
    ).not.toThrow();

    expect(() =>
      inline('import Branch from "./branch.glts"; export default Branch;', {
        "./branch.glts": `const load = () => import("three");
export default class Branch {}`
      })
    ).toThrow("Dynamic imports are not supported");
  });

  it.each([
    {
      name: "missing files",
      files: {},
      source: 'import Branch from "./branch.glts"; export default Branch;',
      message: "Missing inline source"
    },
    {
      name: "named local imports",
      files: { "./branch.glts": "export default class Branch {}" },
      source: 'import { Branch } from "./branch.glts"; export default Branch;',
      message: "Local GLTS imports must be default imports"
    },
    {
      name: "dependency named exports",
      files: {
        "./branch.glts": "export const value = 1; export default class Branch {}"
      },
      source: 'import Branch from "./branch.glts"; export default Branch;',
      message: "Inlined dependencies may only have a default export"
    },
    {
      name: "cycles",
      files: {
        "./a.glts": 'import B from "./b.glts"; export default class A {}',
        "./b.glts": 'import A from "./a.glts"; export default class B {}'
      },
      source: 'import A from "./a.glts"; export default A;',
      message: "Cyclic GLTS imports are not supported"
    },
    {
      name: "external binding collisions",
      files: {
        "./a.glts": 'import { Value } from "a"; export default class A {}',
        "./b.glts": 'import { Value } from "b"; export default class B {}'
      },
      source:
        'import A from "./a.glts"; import B from "./b.glts"; export default class Root {}',
      message: 'External import "Value" conflicts'
    }
  ])("rejects $name", ({ files, message, source }) => {
    expect(() => inline(source, files)).toThrow(GLTSError);
    expect(() => inline(source, files)).toThrow(message);
  });
});
