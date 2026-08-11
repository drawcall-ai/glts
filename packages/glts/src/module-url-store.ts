export class ModuleURLStore {
  readonly #urls = new Set<string>();

  create(source: string): string {
    const blob = new Blob([source], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    this.#urls.add(url);
    return url;
  }

  dispose(): void {
    for (const url of this.#urls) {
      URL.revokeObjectURL(url);
    }

    this.#urls.clear();
  }
}
