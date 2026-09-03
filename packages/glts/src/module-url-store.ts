export class ModuleURLStore {
  readonly #urls = new Set<string>();
  #disposed = false;

  create(source: string): string {
    if (this.#disposed) {
      throw new Error("Module URL store has been disposed");
    }

    const blob = new Blob([source], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    this.#urls.add(url);
    return url;
  }

  release(url: string): void {
    if (!this.#urls.delete(url)) {
      return;
    }

    URL.revokeObjectURL(url);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }

    this.#disposed = true;
    for (const url of this.#urls) {
      URL.revokeObjectURL(url);
    }

    this.#urls.clear();
  }
}
