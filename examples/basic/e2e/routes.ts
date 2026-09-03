import type { Page, Route } from "@playwright/test";

type RoutePattern = string | RegExp;

export function assetSource(name: string, child?: string): string {
  const childLoad = child
    ? `scene.add(await gltsLoader.loadAsync(new URL(${JSON.stringify(child)}, import.meta.url)))`
    : "";

  return `
    import { gltsLoader, scene } from "@drawcall/glts"
    scene.name = ${JSON.stringify(name)}
    ${childLoad}
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
