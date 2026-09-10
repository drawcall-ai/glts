export function bindFileDrop(
  viewer: HTMLElement,
  onFile: (file: File) => void,
  onError: (message: string) => void
): () => void {
  let dragDepth = 0;

  function draggedFiles(event: DragEvent): FileList | undefined {
    return event.dataTransfer?.types.includes("Files")
      ? event.dataTransfer.files
      : undefined;
  }

  function showDropTarget(event: DragEvent): void {
    if (!draggedFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    viewer.dataset.dragging = "";
  }

  function keepDropTarget(event: DragEvent): void {
    if (!draggedFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  function hideDropTarget(event: DragEvent): void {
    if (!draggedFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) delete viewer.dataset.dragging;
  }

  function dropFile(event: DragEvent): void {
    const files = draggedFiles(event);
    if (!files) return;
    event.preventDefault();
    dragDepth = 0;
    delete viewer.dataset.dragging;
    if (files.length !== 1) {
      onError("Drop one self-contained .glts file at a time.");
      return;
    }
    const file = files.item(0);
    if (!file) {
      throw new Error("Dropped file is missing");
    }
    onFile(file);
  }

  window.addEventListener("dragenter", showDropTarget);
  window.addEventListener("dragover", keepDropTarget);
  window.addEventListener("dragleave", hideDropTarget);
  window.addEventListener("drop", dropFile);

  return () => {
    window.removeEventListener("dragenter", showDropTarget);
    window.removeEventListener("dragover", keepDropTarget);
    window.removeEventListener("dragleave", hideDropTarget);
    window.removeEventListener("drop", dropFile);
  };
}
