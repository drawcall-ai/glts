import type { Page, Route } from "@playwright/test";

type RoutePattern = string | RegExp;

export function assetSource(name: string, child?: string): string {
  const childImport = child ? `import Child from ${JSON.stringify(child)}` : "";
  const childMount = child ? "this.add(new Child())" : "";

  return `
    import * as THREE from "three"
    ${childImport}
    export default class Asset extends THREE.Group {
      constructor() {
        super()
        this.name = ${JSON.stringify(name)}
        ${childMount}
      }
    }
  `;
}

export function fulfillGLTS(route: Route, source: string): Promise<void> {
  return route.fulfill({ body: source, contentType: "text/plain" });
}

export function routeGLTS(page: Page, pattern: RoutePattern, source: string) {
  return page.route(pattern, (route) => fulfillGLTS(route, source));
}

export async function routeGLTSRevisions(
  page: Page,
  pattern: RoutePattern,
  sources: readonly string[]
): Promise<{ readonly requests: number }> {
  const state = { requests: 0 };
  await page.route(pattern, (route) => {
    const source = sources[state.requests];
    state.requests += 1;
    if (source === undefined) {
      throw new Error(
        `No GLTS revision ${state.requests} for ${route.request().url()}; ${sources.length} configured`
      );
    }

    return fulfillGLTS(route, source);
  });
  return state;
}
