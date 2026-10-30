import { GLTSError, type GLTSErrorDetails } from "../errors.js";
import type { Dependencies } from "../dependencies.js";
import type { GLTSLoaderOptions } from "../types.js";
import { hasVersion, isBareSpecifier, packageName } from "./resolution.js";

export async function sourceHash(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Records the actual origin of a namespace supplied by the host. A versioned namespace without module hashes still
 * loads, but reading the provenance fails, since no installed package names its content.
 */
export function recordHost(specifier: string, moduleSources: GLTSLoaderOptions["moduleSources"], dependencies: Dependencies, details: GLTSErrorDetails): void {
  if (!isBareSpecifier(specifier)) return;
  const source = moduleSources?.[specifier];
  if (hasVersion(specifier) && (!source || Object.keys(source.moduleHashes).length === 0)) {
    dependencies.addUnknown(new GLTSError(`Supplied versioned namespace ${specifier} requires moduleSources with source-content hashes to report its provenance`, details));
    return;
  }
  if (source) {
    for (const name of source.packages) dependencies.addPackage(name);
    for (const [url, hash] of Object.entries(source.moduleHashes)) dependencies.addModule(url, hash, "bundled");
    return;
  }
  dependencies.addPackage(packageName(specifier));
}
